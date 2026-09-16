import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function installService(config, { home = homedir() } = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  if (process.platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', 'dev.iamyourboss.server.plist');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.iamyourboss.server</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(serverPath)}</string></array>
<key>EnvironmentVariables</key><dict><key>IYB_DATA_DIR</key><string>${xml(config.dataDir)}</string><key>IYB_HOST</key><string>${xml(config.host)}</string><key>IYB_PORT</key><string>${config.port}</string><key>PATH</key><string>${xml(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(config.logPath)}</string><key>StandardErrorPath</key><string>${xml(config.logPath)}</string>
</dict></plist>\n`);
    const domain = `gui/${process.getuid()}`;
    spawnSync('launchctl', ['bootout', domain, path], { stdio: 'ignore' });
    const result = spawnSync('launchctl', ['bootstrap', domain, path], { encoding: 'utf8' });
    return { persistent: result.status === 0, detail: result.status === 0 ? 'launchd user service' : (result.stderr || 'launchctl bootstrap failed').trim(), path };
  }
  if (process.platform === 'linux' && spawnSync('systemctl', ['--user', '--version'], { stdio: 'ignore' }).status === 0) {
    const path = join(home, '.config', 'systemd', 'user', 'iamyourboss.service');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `[Unit]\nDescription=iamyourboss advisor server\n\n[Service]\nExecStart=${process.execPath} ${serverPath}\nRestart=on-failure\nEnvironment=IYB_DATA_DIR=${config.dataDir}\nEnvironment=IYB_HOST=${config.host}\nEnvironment=IYB_PORT=${config.port}\nEnvironment=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}\n\n[Install]\nWantedBy=default.target\n`);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const result = spawnSync('systemctl', ['--user', 'enable', '--now', 'iamyourboss.service'], { encoding: 'utf8' });
    return { persistent: result.status === 0, detail: result.status === 0 ? 'systemd user service' : (result.stderr || 'systemd enable failed').trim(), path };
  }
  return { persistent: false, detail: 'background process (no supported user service manager found)' };
}

export function uninstallService({ home = homedir() } = {}) {
  if (process.platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', 'dev.iamyourboss.server.plist');
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, path], { stdio: 'ignore' });
    if (existsSync(path)) unlinkSync(path);
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'iamyourboss.service'], { stdio: 'ignore' });
    const path = join(home, '.config', 'systemd', 'user', 'iamyourboss.service');
    if (existsSync(path)) unlinkSync(path);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  }
}
