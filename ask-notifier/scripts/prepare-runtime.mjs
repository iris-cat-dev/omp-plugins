import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portable = path.join(packageRoot, 'runtime', 'python', 'python.exe');
const privateRoot = path.join(packageRoot, '.runtime', 'python');
const privatePython = path.join(privateRoot, 'Scripts', 'python.exe');
const requirements = path.join(packageRoot, 'bridge', 'requirements.txt');
const PSUTIL_VERSION = '7.2.2';
const dependencyDescription = `psutil==${PSUTIL_VERSION}`;

function run(executable, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: packageRoot, windowsHide: true, shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    }
    child.on('error', (error) => reject(new Error(`无法启动 Python：${error.message}`)));
    child.on('close', (code) => code === 0 ? resolve(stdout.trim())
      : reject(new Error(`Python 执行失败（退出码 ${code}）${stderr.trim() ? `：${stderr.trim()}` : '，请查看上方错误。'}`)));
  });
}

async function checkPython(executable, { dependencies = false, venv = false } = {}) {
  const source = [
    'import json,struct,sys',
    dependencies ? 'import psutil' : '',
    `print(json.dumps({'version':list(sys.version_info[:3]),'bits':struct.calcsize('P')*8,'venv':sys.prefix!=sys.base_prefix,'psutil':${dependencies ? 'psutil.__version__' : 'None'}}))`,
  ].filter(Boolean).join(';');
  let info;
  try { info = JSON.parse(await run(executable, ['-I', '-B', '-c', source], { capture: true })); }
  catch (error) {
    throw new Error(`${dependencies ? `提醒运行时不可用，需包含 ${dependencyDescription}。` : '无法检查所选 Python。'}${error.message}`);
  }
  if (info.bits !== 64 || info.version[0] !== 3 || info.version[1] < 11) {
    throw new Error('需要 Python 3.11 或更新版本的 Windows x64 版，推荐与分发包一致的 Python 3.13.17；不会修改系统 Python。');
  }
  if (venv && !info.venv) throw new Error('私有运行时不是独立 venv，已停止；不会向系统 Python 安装依赖。');
  if (dependencies && info.psutil !== PSUTIL_VERSION) {
    throw new Error(`提醒运行时需要 ${dependencyDescription}，当前为 psutil ${info.psutil}。请重新解压完整分发包，或重新准备私有运行时。`);
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('QQ 提醒运行时仅支持 Windows x64。');
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--python')) {
    throw new Error('只接受可选参数 --python <Python.exe 的绝对路径>。');
  }
  const basePython = args[1];
  if (basePython && (!path.isAbsolute(basePython) || !existsSync(basePython))) {
    throw new Error('--python 必须指向已存在的 Python.exe 绝对路径；请选择 Windows x64 版，推荐 Python 3.13.17（最低支持 3.11）。');
  }
  const override = process.env.OMP_QQ_NOTIFIER_PYTHON;
  if (override) {
    if (!path.isAbsolute(override) || !existsSync(override)) throw new Error('OMP_QQ_NOTIFIER_PYTHON 必须是已存在的 Python.exe 绝对路径。');
    await checkPython(override, { dependencies: true });
    console.log('提醒运行时已就绪（使用明确指定的独立 Python）。未连接 QQ。');
    return;
  }
  if (existsSync(portable)) {
    try { await checkPython(portable, { dependencies: true }); }
    catch (error) { throw new Error(`${error.message}\n请重新解压含 runtime 文件夹的完整 QQ 提醒分发包。不会改动系统 Python。`); }
    console.log('提醒自带运行时已就绪，无需安装 Python。未连接 QQ。');
    return;
  }
  if (!existsSync(privatePython)) {
    if (!basePython) {
      throw new Error('未找到插件自带的 Python。建议重新解压完整分发包；源码使用者可用 --python 指定 Python 3.13.17 Windows x64 的 Python.exe 绝对路径，创建插件私有运行时。本操作不需要 PATH 中存在 node，也不会修改系统 Python。');
    }
    await checkPython(basePython);
    console.log('正在为本插件创建独立 Python 运行时……');
    await run(basePython, ['-I', '-B', '-m', 'venv', privateRoot]);
  }
  await checkPython(privatePython, { venv: true });
  try {
    await checkPython(privatePython, { dependencies: true, venv: true });
  } catch {
    console.log(`正在仅向插件私有运行时安装 ${dependencyDescription}……`);
    try {
      await run(privatePython, ['-I', '-B', '-m', 'pip', 'install', '--require-virtualenv', '--disable-pip-version-check', '-r', requirements]);
    } catch (error) {
      throw new Error(`私有运行时依赖安装失败。请检查网络后重新双击“准备提醒.cmd”；不会改动系统 Python。\n${error.message}`);
    }
    await checkPython(privatePython, { dependencies: true, venv: true });
  }
  console.log('QQ 提醒私有运行时已就绪。未连接 QQ。请在 OMP 插件管理中启用本插件，再到“OMP 询问提醒”设置页开启自动提醒。');
}

main().catch((error) => {
  console.error(`准备 QQ 提醒失败：${error.message}`);
  process.exitCode = 1;
});
