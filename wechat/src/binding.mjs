import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Runs only after an explicit operator request; never forwards process diagnostics to the UI. */
export async function createBinding({ root, directory, pythonPath, accountId, pid, contactDatabase, signal, spawnProcess = spawn }) {
  if (!path.isAbsolute(pythonPath) || !path.isAbsolute(contactDatabase) || pythonPath.includes('\0') || contactDatabase.includes('\0')) throw new Error('Python 与联系人数据库必须使用绝对路径');
  signal.throwIfAborted();
  let expectedContact;
  try { expectedContact = await realpath(contactDatabase); } catch { throw new Error('无法读取所选联系人数据库'); }
  const bindingDir = path.join(directory, 'bindings');
  try { await mkdir(bindingDir, { recursive: true, mode: 0o700 }); } catch { throw new Error('无法创建插件绑定目录'); }
  signal.throwIfAborted();
  const destination = path.join(bindingDir, `${randomUUID()}.json`);
  const args = ['-B', path.join(root, 'bridge', 'create_binding.py'), '--account-id', accountId, '--pid', String(pid), '--contact-database', contactDatabase, '--output', destination, '--allow-read'];
  await new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => { if (child) child.kill(); };
    try {
      child = spawnProcess(pythonPath, args, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: '', PYTHONHOME: '' } });
      child.once('error', () => finish(new Error('无法启动绑定核验程序')));
      child.once('close', code => {
        if (signal.aborted) finish(new Error('绑定核验已取消，未回填结果'));
        else if (code !== 0) finish(new Error('绑定核验未通过，请检查所选账号、进程和联系人数据库'));
        else finish();
      });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    } catch { finish(new Error('无法启动绑定核验程序')); }
  });
  signal.throwIfAborted();
  let bytes;
  try { bytes = await readFile(destination); } catch { throw new Error('绑定核验未生成有效资料'); }
  signal.throwIfAborted();
  if (bytes.length > 65536) throw new Error('生成的绑定资料无效');
  let binding;
  try { binding = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('生成的绑定资料无效'); }
  const normalize = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  if (!binding || Object.keys(binding).sort().join(',') !== 'accountId,contactDatabaseFiles,createdAtMs,pid' || binding.accountId !== accountId || binding.pid !== pid || !Number.isSafeInteger(binding.createdAtMs) || binding.createdAtMs <= 0 || !Array.isArray(binding.contactDatabaseFiles) || binding.contactDatabaseFiles.length !== 1 || typeof binding.contactDatabaseFiles[0] !== 'string' || normalize(binding.contactDatabaseFiles[0]) !== normalize(expectedContact)) throw new Error('生成的绑定资料与本次选择不符');
  signal.throwIfAborted();
  return { bindingPath: destination };
}
