import { buildServer } from './app/buildServer.js'
import { getServerEnv } from './config/env.js'

const env = getServerEnv()
const server = await buildServer()

try {
  await server.listen({ host: '0.0.0.0', port: env.port })
} catch (error) {
  server.log.error(error)
  process.exitCode = 1
}
