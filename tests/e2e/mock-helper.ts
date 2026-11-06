/**
 * E2E mock-LLM helper: starts one scripted server for one gate child, prints
 * its base URL, and stays alive until the wrapper terminates it. The script
 * file path arrives in `LCRD_E2E_SCRIPT`; the gate wrapper picks a fresh script
 * per child so probe, baseline, and candidate runs never share a FIFO cursor.
 *
 * @module lcrd-e2e-mock-helper
 */
import { readFileSync } from 'node:fs'
import { startMockLlmServer, type MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server'

const scriptPath = process.env['LCRD_E2E_SCRIPT']
if (scriptPath === undefined) throw new Error('lcrd e2e: LCRD_E2E_SCRIPT is required')
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as MockLlmServerOptions
const server = await startMockLlmServer({ ...script, port: 0 })
process.stdout.write(`${server.baseURL}\n`)

/** Stop the server and exit cleanly. */
const stop = (): void => {
  void server.close().finally(() => { process.exit(0) })
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => {}, 1 << 30)
