import 'dotenv/config';
import { executeShell } from '../core/tools/shell.js';

async function main(): Promise<void> {
  console.log('--- Test 1: Successful command ---');
  const r1 = await executeShell('echo hello world');
  console.log(`ok=${r1.ok} output="${r1.output}"`);
  if (!r1.ok || !r1.output.includes('hello world')) {
    console.error('[FAIL] Expected ok=true with "hello world"');
    process.exit(1);
  }
  console.log('[OK] Successful command\n');

  console.log('--- Test 2: Failing command ---');
  const r2 = await executeShell('ls /nonexistent_path_12345');
  console.log(`ok=${r2.ok} output="${r2.output.slice(0, 120)}"`);
  if (r2.ok) {
    console.error('[FAIL] Expected ok=false for failing command');
    process.exit(1);
  }
  console.log('[OK] Failing command returns ok=false\n');

  console.log('--- Test 3: No output ---');
  const r3 = await executeShell('true');
  console.log(`ok=${r3.ok} output="${r3.output}"`);
  if (!r3.ok) {
    console.error('[FAIL] Expected ok=true for "true" command');
    process.exit(1);
  }
  console.log('[OK] No-output command\n');

  console.log('--- Test 4: Non-zero exit code ---');
  const r4 = await executeShell('exit 42');
  console.log(`ok=${r4.ok} output="${r4.output.slice(0, 120)}"`);
  if (r4.ok) {
    console.error('[FAIL] Expected ok=false for non-zero exit');
    process.exit(1);
  }
  if (!r4.output.includes('42')) {
    console.error('[FAIL] Expected exit code 42 in output');
    process.exit(1);
  }
  console.log('[OK] Non-zero exit code\n');

  console.log('--- Test 5: Large output truncation ---');
  const r5 = await executeShell('seq 1 100000');
  console.log(`ok=${r5.ok} outputLength=${r5.output.length} truncated=${r5.output.includes('truncated')}`);
  if (r5.ok) {
    console.error('[FAIL] Expected ok=false when maxBuffer is exceeded');
    process.exit(1);
  }
  if (!r5.output.includes('truncated')) {
    console.error('[FAIL] Expected output to be truncated');
    process.exit(1);
  }
  console.log('[OK] Large output hits maxBuffer, gets truncated, reported as error\n');

  console.log('All shell tool tests passed.');
}

void main();
