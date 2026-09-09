/**
 * Fixture fleet for the CBM cross-repo relationship measurement (#14, PRD
 * §17 item 3 / §8.2): five tiny JS repositories whose cross-repo links are
 * known BY CONSTRUCTION — every expected link and every deliberate trap is
 * listed in ground-truth.json.
 *
 * The fixtures use exactly the framework idioms CBM claims to detect
 * (express / fetch / axios / kafkajs / @grpc/grpc-js / @apollo/client), so a
 * miss means the extractor or the cross-repo matcher failed, not that the
 * code was exotic.
 *
 * writeFixtures(root) creates <root>/<repo>/ as real git repos (CBM requires
 * git) and is idempotent-ish: it refuses to overwrite an existing directory.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })

function repo(root, name, files) {
  const dir = join(root, name.replaceAll('/', '-'))
  if (existsSync(dir)) throw new Error(`fixture target already exists: ${dir}`)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', type: 'module' }, null, 2)}\n`)
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=bench@baize', '-c', 'user.name=baize-bench', 'commit', '-qm', 'fixture')
  return { name, dir }
}

// The server: HTTP routes (express), a Kafka producer (kafkajs), a gRPC
// service (proto + grpc-js server shape), and a GraphQL schema (schema file
// + graphql-js resolver).
const ORDERS_API = {
  // Named handler references: CBM's HANDLES edge (which cross-repo matching
  // requires) is only emitted for identifier/string handler arguments — an
  // inline arrow function handler produces a Route with no HANDLES edge and
  // can never be linked cross-repo (verified against pass_cross_repo.c).
  'src/http.js': `import express from 'express'

async function listOrders(req, res) {
  res.json(req.app.locals.orders)
}

async function chargePayment(req, res) {
  res.json({ charged: true })
}

export function createHttpServer() {
  const app = express()
  app.get('/orders', listOrders)
  app.post('/payments', chargePayment)
  return app
}
`,
  'src/events.js': `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'orders-api', brokers: ['kafka:9092'] })

export async function publishOrderCreated(order) {
  const producer = kafka.producer()
  await producer.send({ topic: 'orders.created', messages: [{ value: JSON.stringify(order) }] })
}
`,
  // The in-process pub/sub pair (EventEmitter): the one channel transport
  // CBM documents for JS. The listener is a named function — LISTENS_ON, like
  // HANDLES, needs a resolvable handler.
  'src/bus.js': `import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()

export function emitOrderCreated(order) {
  bus.emit('order.created', order)
}
`,
  'proto/shop/orders.proto': `syntax = "proto3";
package shop.orders.v1;

service OrderService {
  rpc GetOrder (GetOrderRequest) returns (Order);
}

message GetOrderRequest {
  string id = 1;
}

message Order {
  string id = 1;
  int32 total_cents = 2;
}
`,
  'src/grpc.js': `import { Server, ServerCredentials } from '@grpc/grpc-js'
import { OrderServiceService } from './generated/orders_grpc_pb'

export function createGrpcServer(orderService) {
  const server = new Server()
  server.addService(OrderServiceService, {
    getOrder: (call, callback) => orderService.get(call.request.id).then((o) => callback(null, o), callback),
  })
  server.bindAsync('0.0.0.0:50051', ServerCredentials.createInsecure(), () => {})
  return server
}
`,
  'schema/order.graphql': `type Query {
  order(id: ID!): Order
}

type Order {
  id: ID!
  totalCents: Int!
}
`,
  'src/graphql.js': `import { buildSchema, graphql } from 'graphql'
import { readFileSync } from 'node:fs'

const schema = buildSchema(readFileSync(new URL('../schema/order.graphql', import.meta.url), 'utf8'))
const root = {
  order: ({ id }) => ({ id, totalCents: 1999 }),
}
export function handleGraphql(query, variables) {
  return graphql({ schema, source: query, rootValue: root, variableValues: variables })
}
`,
}

// Client #1: relative-path fetch, axios with host, a Kafka consumer, a gRPC
// client, and an Apollo GraphQL query — one repo exercising every inbound
// relationship type.
const WEB_BFF = {
  'src/http.js': `import axios from 'axios'

const ordersApi = axios.create({ baseURL: 'http://orders-api:3000' })

export async function loadOrders() {
  const res = await fetch('/orders')
  return res.json()
}

export async function payOrder(payment) {
  const res = await ordersApi.post('/payments', payment)
  return res.data
}
`,
  'src/events.js': `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'web-bff', brokers: ['kafka:9092'] })

export async function startOrderConsumer(handle) {
  const consumer = kafka.consumer({ groupId: 'web-bff' })
  await consumer.connect()
  await consumer.subscribe({ topics: ['orders.created'] })
  await consumer.run({ eachMessage: async ({ message }) => handle(message.value.toString()) })
}
`,
  'src/grpc.js': `import { credentials } from '@grpc/grpc-js'
import { OrderServiceClient } from './generated/orders_grpc_pb'

export function createOrderClient(url) {
  return new OrderServiceClient(url, credentials.createInsecure())
}

export function fetchOrder(client, id) {
  return new Promise((resolve, reject) => {
    client.getOrder({ id }, (err, response) => (err ? reject(err) : resolve(response)))
  })
}
`,
  'src/bus.js': `import { EventEmitter } from 'node:events'

const bus = new EventEmitter()

export function onOrderCreated(order) {
  return order
}

export function startBus() {
  bus.on('order.created', onOrderCreated)
  return bus
}
`,
  'src/graphql.js': `import { gql } from '@apollo/client'

export const ORDER_QUERY = gql\`
  query Order($id: ID!) {
    order(id: $id) {
      id
      totalCents
    }
  }
\`
`,
}

// Client #2: a second HTTP + Kafka consumer, so a topic with two consumers
// and a route with two clients both count.
const BILLING = {
  'src/http.js': `import axios from 'axios'

export async function settlePayment(payment) {
  const res = await axios.post('http://orders-api:3000/payments', payment)
  return res.data
}
`,
  'src/events.js': `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'billing', brokers: ['kafka:9092'] })

export async function startBillingConsumer(onOrderCreated) {
  const consumer = kafka.consumer({ groupId: 'billing' })
  await consumer.connect()
  await consumer.subscribe({ topics: ['orders.created'] })
  await consumer.run({ eachMessage: async ({ message }) => onOrderCreated(message.value.toString()) })
}
`,
}

// Trap #1 — string-only references: URLs that appear in constants and
// comments but are never fetched. Any CROSS_HTTP_CALLS out of this repo is a
// false positive by construction.
const NOISE_STRING = {
  'src/docs.js': `// Setup docs: the orders API lives at http://orders-api:3000/orders
// Payments endpoint for manual testing: http://orders-api:3000/payments
export const ORDERS_DOC_URL = 'http://orders-api:3000/orders'
export const PAYMENTS_DOC_URL = 'http://orders-api:3000/payments'
`,
}

// Trap #2 — near-miss topics: a producer on a DIFFERENT topic name and a
// consumer for a topic nobody produces. 'orders.created.v2' must not link to
// 'orders.created'; 'payments.settled' must link to nothing.
const NOISE_TOPIC = {
  'src/events.js': `import { Kafka } from 'kafkajs'

const kafka = new Kafka({ clientId: 'metrics', brokers: ['kafka:9092'] })

export async function publishOrderCreatedV2(order) {
  const producer = kafka.producer()
  await producer.send({ topic: 'orders.created.v2', messages: [{ value: JSON.stringify(order) }] })
}

export async function startSettledConsumer(onSettled) {
  const consumer = kafka.consumer({ groupId: 'noise' })
  await consumer.connect()
  await consumer.subscribe({ topics: ['payments.settled'] })
  await consumer.run({ eachMessage: async ({ message }) => onSettled(message.value.toString()) })
}
`,
}

/** Fleet repo name → CBM project name (CBM uses the directory name). */
export const FLEET = [
  { repo: 'shop/orders-api', project: 'shop-orders-api', kind: 'server', files: ORDERS_API },
  { repo: 'shop/web-bff', project: 'shop-web-bff', kind: 'client', files: WEB_BFF },
  { repo: 'shop/billing', project: 'shop-billing', kind: 'client', files: BILLING },
  { repo: 'noise/string-refs', project: 'noise-string-refs', kind: 'trap', files: NOISE_STRING },
  { repo: 'noise/topics', project: 'noise-topics', kind: 'trap', files: NOISE_TOPIC },
]

export function writeFixtures(root) {
  return FLEET.map(({ repo: repoName, project, files }) => {
    const dir = repo(root, repoName, files).dir
    return { repo: repoName, project, dir }
  })
}
