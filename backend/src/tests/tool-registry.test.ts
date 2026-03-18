import 'dotenv/config';
import { toolRegistry } from '../core/tool-registry.js';

async function main(): Promise<void> {
  console.log('--- Test 1: loadTools returns definitions and dispatch ---');
  const { definitions, dispatch } = await toolRegistry.loadTools();
  console.log(`definitions: ${definitions.length}, dispatch keys: ${dispatch.size}`);

  if (definitions.length === 0) {
    console.error('[FAIL] Expected at least 1 tool definition (shell_exec)');
    process.exit(1);
  }
  console.log('[OK] loadTools returns non-empty results\n');

  console.log('--- Test 2: shell_exec is registered ---');
  const shellDef = definitions.find((d) => d.function.name === 'shell_exec');
  if (!shellDef) {
    console.error('[FAIL] shell_exec not found in definitions');
    process.exit(1);
  }
  console.log(`shell_exec definition: ${JSON.stringify(shellDef.function.name)} params=${JSON.stringify(Object.keys(shellDef.function.parameters))}`);
  console.log('[OK] shell_exec is registered\n');

  console.log('--- Test 3: shell_exec dispatch works ---');
  const handler = dispatch.get('shell_exec');
  if (!handler) {
    console.error('[FAIL] shell_exec handler not in dispatch map');
    process.exit(1);
  }
  const result = await handler({ command: 'echo registry-test' });
  console.log(`ok=${result.ok} output="${result.output}"`);
  if (!result.ok || !result.output.includes('registry-test')) {
    console.error('[FAIL] Expected ok=true with "registry-test" in output');
    process.exit(1);
  }
  console.log('[OK] shell_exec dispatch works\n');

  console.log('--- Test 4: shell_exec rejects empty command ---');
  const emptyResult = await handler({ command: '' });
  console.log(`ok=${emptyResult.ok} output="${emptyResult.output}"`);
  if (emptyResult.ok) {
    console.error('[FAIL] Expected ok=false for empty command');
    process.exit(1);
  }
  console.log('[OK] Empty command rejected\n');

  console.log('--- Test 5: Definitions match Ollama tool format ---');
  for (const def of definitions) {
    if (def.type !== 'function') {
      console.error(`[FAIL] Tool "${def.function.name}" has type "${def.type}", expected "function"`);
      process.exit(1);
    }
    if (!def.function.name || typeof def.function.name !== 'string') {
      console.error('[FAIL] Tool missing name');
      process.exit(1);
    }
    if (typeof def.function.parameters !== 'object') {
      console.error(`[FAIL] Tool "${def.function.name}" parameters is not an object`);
      process.exit(1);
    }
  }
  console.log(`[OK] All ${definitions.length} definitions match Ollama tool format\n`);

  console.log('All tool registry tests passed.');
}

void main();
