// BaiZe desktop shell (issue #18, PRD §6.5 / §17 item 7).
//
// The product is the webview the baize Node server serves; this executable
// exists for exactly the two things a browser cannot do:
//   1. own the server process — spawn the sidecar (plain per-platform Node
//      binary + bundled JS; NOT Node SEA, which breaks child_process.fork
//      by design, PRD §6.5) in its own process group;
//   2. guarantee the whole process tree dies with the app — Tauri does NOT
//      kill sidecar children on quit, so RunEvent::Exit SIGTERMs the group
//      (server -> git children, OMP agents, CBM + its daemon), waits, then
//      SIGKILLs what is left.
//
// Window: created programmatically after /api/health answers, pointed at
// the sidecar's dynamically chosen port — that is why tauri.conf.json
// declares no static window and frontendDist is a placeholder.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tokio::process::{Child, Command};

/// Where the sidecar's stdout/stderr go — greppable, and survives a crash
/// that takes the window down with it.
fn sidecar_log_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("baize-desktop"));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("sidecar.log")
}

/// A free port for the server: bind :0, read the assigned port, drop the
/// listener. The race window (another process grabbing the port before the
/// server binds) is the server's startup error to report, not ours to hide.
fn free_port() -> u16 {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .expect("bind 127.0.0.1:0 for a free port")
        .local_addr()
        .expect("read assigned port")
        .port()
}

/// Minimal HTTP client for the health check — a dependency-free GET is all
/// the shell needs (the webview does all real HTTP once the server is up).
/// Ok(()) on HTTP 200, Err(reason) otherwise.
fn health_check(port: u16) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    use std::io::{Read, Write};
    stream
        .write_all(
            format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    let mut buf = [0u8; 256];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let head = String::from_utf8_lossy(&buf[..n]);
    if head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(format!("unexpected health response: {}", head.lines().next().unwrap_or("")))
    }
}

/// Spawn the sidecar in its own process group. Group ownership is what makes
/// the exit sweep complete: killing -pgid takes down the server AND every
/// child it spawned (git, OMP, CBM stdio child, CBM daemon) even if the
/// server itself is wedged — the belt to the server's own SIGTERM cleanup
/// braces (src/cli.js shutdown path).
async fn spawn_sidecar(app: &tauri::AppHandle, port: u16) -> Result<Child, String> {
    // Resource layout differs by build: a bundle resolves resource_dir() to
    // the app's Resources/, but a plain `cargo build` binary resolves it to
    // target/debug/ — there the source tree's resources/ is the truth.
    #[cfg(debug_assertions)]
    let resource = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    #[cfg(not(debug_assertions))]
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir: {e}"))?;
    let base = resource.join("baize");
    let node = base.join("bin").join("node");
    let entry = base.join("src").join("cli.js");

    for (what, path) in [("node binary", &node), ("server entry", &entry)] {
        if !path.exists() {
            return Err(format!(
                "{what} missing at {} — run desktop/scripts/package-sidecar.mjs first",
                path.display()
            ));
        }
    }

    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(sidecar_log_path(app))
        .map_err(|e| format!("open sidecar log: {e}"))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("clone sidecar log handle: {e}"))?;

    #[cfg(unix)]
    let mut command = {
        let mut c = Command::new(&node);
        // Own process group (pgid == child pid): the exit sweep below kills
        // the whole tree via kill(-pgid). tokio::process::Command has this
        // natively (std's CommandExt does not apply to it).
        c.process_group(0);
        c
    };
    #[cfg(not(unix))]
    let mut command = Command::new(&node);

    command
        .args([entry.as_os_str(), "--no-open".as_ref(), "-p".as_ref(), port.to_string().as_ref()])
        .stdout(log_file)
        .stderr(log_err)
        // Orphan guard for teardown paths that reach destructors (panic on
        // the setup thread): dropping the Child hard-kills the direct child.
        // The Exit sweep remains the authoritative, tree-wide cleanup.
        .kill_on_drop(true)
        .spawn()
        .map(|child| {
            eprintln!("[baize-desktop] sidecar spawned: {} src/cli.js -p {port} (pid {:?})", node.display(), child.id());
            child
        })
        .map_err(|e| format!("spawn sidecar {}: {e}", node.display()))
}

/// try_wait without consuming; true when the child has exited.
fn try_reap(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

/// The authoritative cleanup (PRD §6.5: "the shell must kill the whole
/// process tree on quit"). SIGTERM the child's PROCESS GROUP, give the
/// server's graceful shutdown its worst-case budget, then SIGKILL the
/// surviving group. A positive pid would only reach the server process
/// itself — the whole point of the group kill is taking down git/OMP/CBM
/// children when the server is wedged and cleans up nothing itself. Runs on
/// RunEvent::Exit — synchronous, because tao ends the event loop with
/// std::process::exit and async teardown would never run (same lesson as
/// Panda's exit sweep).
fn sweep_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            // Negative pid = the child's process group (pgid == child pid,
            // set at spawn). SAFETY: signaling our own child's group.
            let pgid = -(pid as libc::pid_t);
            unsafe { libc::kill(pgid, libc::SIGTERM) };
            // The server's graceful path needs up to ~20s worst case:
            // app.stop → cbm.stop (5s child-SIGKILL budget) + `daemon stop`
            // (15s timeout). 25s covers it before we group-SIGKILL.
            let deadline = Instant::now() + Duration::from_secs(25);
            while !try_reap(child) {
                if Instant::now() >= deadline {
                    eprintln!("[baize-desktop] exit sweep: SIGKILLing the sidecar group");
                    unsafe { libc::kill(pgid, libc::SIGKILL) };
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    #[cfg(not(unix))]
    {
        // Windows feasibility (desktop/README.md): Job Objects are the
        // correct tree-kill primitive there; Child::kill covers only the
        // direct child, so a Windows ship needs that TODO resolved first.
        let _ = child.start_kill();
        let _ = child.try_wait();
    }
}

/// Drive one sidecar to a healthy window. Runs on its own thread with its
/// own small tokio runtime; on failure it tears the sidecar down and shows
/// the error instead of opening a dead window.
async fn run_sidecar(app: tauri::AppHandle) {
    let port = free_port();
    eprintln!("[baize-desktop] sidecar port {port}");

    let child = match spawn_sidecar(&app, port).await {
        Ok(child) => child,
        Err(err) => return fatal(&app, err),
    };

    // Manage IMMEDIATELY after spawn: both exit paths (RunEvent::Exit and
    // the sigwait thread) sweep the managed child, so quitting during the
    // up-to-30s health gate below still tears the sidecar down instead of
    // orphaning it (process::exit skips destructors, kill_on_drop is dead
    // code on this path — only the sweep reaches the child).
    app.manage(std::sync::Mutex::new(child));
    let child_state = app.state::<std::sync::Mutex<Child>>();

    // Health gate: 30s covers a cold first start (config bootstrap, CBM
    // binary check) without hanging forever on a broken sidecar.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match health_check(port) {
            Ok(()) => break,
            Err(reason) => {
                let mut guard = child_state.lock().unwrap();
                if try_reap(&mut guard) {
                    drop(guard);
                    return fatal(
                        &app,
                        format!("sidecar exited before becoming healthy (log: {})", sidecar_log_path(&app).display()),
                    );
                }
                if Instant::now() >= deadline {
                    sweep_process_tree(&mut guard);
                    drop(guard);
                    return fatal(
                        &app,
                        format!("sidecar not healthy after 30s: {reason} (log: {})", sidecar_log_path(&app).display()),
                    );
                }
                drop(guard);
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
    eprintln!("[baize-desktop] healthy; opening window at http://127.0.0.1:{port}");

    if let Err(err) = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External(format!("http://127.0.0.1:{port}").parse().unwrap()),
    )
    .title("BaiZe")
    .inner_size(1280.0, 800.0)
    .min_inner_size(720.0, 480.0)
    .build()
    {
        let mut guard = child_state.lock().unwrap();
        sweep_process_tree(&mut guard);
        return fatal(&app, format!("create window: {err}"));
    }

    // The sidecar stays parked in managed state for the Exit/sigwait
    // sweeps; this thread parks forever holding the tokio runtime (the
    // runtime owning the Child must outlive the app — dropping it would arm
    // kill_on_drop mid-session and kill a healthy server).
    std::future::pending::<()>().await;
}

/// Surface a startup failure loudly: print it and open a minimal error
/// window, so a broken bundle is a visible diagnosis, not a silently
/// quitting app.
fn fatal(app: &tauri::AppHandle, message: String) {
    eprintln!("[baize-desktop] fatal: {message}");
    let encoded: String = message
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    let url = format!("data:text/html,<h1>BaiZe%20failed%20to%20start</h1><pre>{encoded}</pre>");
    let _ = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(url.parse().unwrap()),
    )
    .title("BaiZe — startup error")
    .inner_size(640.0, 320.0)
    .build();
}

fn main() {
    // Block SIGTERM/SIGINT in the MAIN thread before ANY other thread
    // exists: pthread_sigmask is per-thread and inherited only by threads
    // spawned after it — masking in setup() is too late (Tauri's internal
    // threads already exist unmasked, and a signal delivered to any
    // unmasked thread kills the process, orphaning the sidecar; verified
    // experimentally). With every thread masking, deliveries queue for the
    // sigwait thread spawned in setup, which runs the tree sweep.
    #[cfg(unix)]
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }

    tauri::Builder::default()
        .setup(|app| {
            #[cfg(unix)]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || unsafe {
                    let mut set: libc::sigset_t = std::mem::zeroed();
                    libc::sigemptyset(&mut set);
                    libc::sigaddset(&mut set, libc::SIGTERM);
                    libc::sigaddset(&mut set, libc::SIGINT);
                    loop {
                        let mut sig: libc::c_int = 0;
                        if libc::sigwait(&set, &mut sig) != 0 {
                            break;
                        }
                        eprintln!("[baize-desktop] signal {sig} -> sweeping sidecar tree");
                        // Sweep HERE, then exit: routing through
                        // AppHandle::exit proved unreliable for reaching the
                        // RunEvent::Exit sweep, and std::process::exit skips
                        // destructors anyway — this thread owns the kill
                        // sequence explicitly. The Exit-path sweep stays as
                        // the Cmd+Q / window-close route.
                        if let Some(child) = handle.try_state::<std::sync::Mutex<Child>>() {
                            if let Ok(mut guard) = child.lock() {
                                sweep_process_tree(&mut guard);
                            }
                        }
                        std::process::exit(0);
                    }
                });
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tokio runtime for the sidecar thread");
                rt.block_on(run_sidecar(handle));
                // block_on returns only via pending() (never) or fatal();
                // keep the runtime alive so the managed Child is not dropped.
                std::thread::park();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("baize desktop shell failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(child) = app.try_state::<std::sync::Mutex<Child>>() {
                    let mut guard = child.lock().unwrap();
                    sweep_process_tree(&mut guard);
                }
            }
        });
}
