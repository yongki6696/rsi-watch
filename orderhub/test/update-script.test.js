'use strict';
// 서버 자동 업데이트 스크립트 테스트 (가짜 docker/systemctl 로 실행)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
// 이 PC의 git 전역 설정(서명 등)과 무관하게 서버처럼 깨끗한 설정으로 실행
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orderhub-upd-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // GitHub 역할 (bare) + 개발 PC 역할(dev) + 서버 역할(server)
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  const dev = path.join(root, 'dev');
  git(root, 'clone', '-q', path.join(root, 'origin.git'), 'dev');
  git(dev, 'checkout', '-q', '-b', 'release');
  fs.mkdirSync(path.join(dev, 'orderhub', 'scripts'), { recursive: true });
  for (const f of ['auto-update.sh', 'enable-auto-update.sh']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dev, 'orderhub', 'scripts', f));
  fs.writeFileSync(path.join(dev, 'orderhub', 'version.txt'), '1\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-q', '-m', 'v1');
  git(dev, 'push', '-q', 'origin', 'release');
  git(root, 'clone', '-q', '-b', 'release', path.join(root, 'origin.git'), 'server');
  const server = path.join(root, 'server');

  // 가짜 명령: 호출 기록을 calls.log 에 남김
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${root}/calls.log"\n${body}\n`, { mode: 0o755 });
  fake('docker', [
    'if [ "$1 $2" = "compose up" ] && [ -f "' + root + '/fail-build" ]; then exit 1; fi',
    'if [ "$1 $2" = "compose exec" ] && [ -f "' + root + '/fail-health" ]; then exit 1; fi',
    'exit 0',
  ].join('\n'));
  fake('sleep', 'exit 0');
  fake('systemctl', 'exit 0');
  fake('systemd-run', 'exit 0');

  const env = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${bin}:${process.env.PATH}`,
    ORDERHUB_UPDATE_LOG: path.join(root, 'update.log'),
    ORDERHUB_UPDATE_STATE: path.join(root, 'state'),
    ORDERHUB_HEALTH_WAIT: '6',
  };
  const run = (...args) => spawnSync('bash', [path.join(server, 'orderhub', 'scripts', 'auto-update.sh'), ...args], { env, encoding: 'utf8' });
  const calls = () => (fs.existsSync(path.join(root, 'calls.log')) ? fs.readFileSync(path.join(root, 'calls.log'), 'utf8') : '');
  const clearCalls = () => fs.rmSync(path.join(root, 'calls.log'), { force: true });
  const log = () => fs.readFileSync(path.join(root, 'update.log'), 'utf8');
  const release = (v) => {
    fs.writeFileSync(path.join(dev, 'orderhub', 'version.txt'), `${v}\n`);
    git(dev, 'commit', '-q', '-am', `v${v}`);
    git(dev, 'push', '-q', 'origin', 'release');
    return git(dev, 'rev-parse', 'HEAD');
  };
  const head = () => git(server, 'rev-parse', 'HEAD');
  return { root, server, dev, git, env, run, calls, clearCalls, log, release, head, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('자동 업데이트: 새 버전이 있을 때만 받아서 빌드', () => {
  const t = setup();
  try {
    let r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.calls(), '', '새 버전이 없으면 빌드하지 않음');

    const v2 = t.release(2);
    r = t.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(t.head(), v2);
    assert.match(t.calls(), /docker compose up -d --build/);
    assert.match(t.calls(), /docker compose exec -T app node/);
    assert.match(t.calls(), /docker image prune -f/);
    assert.match(t.log(), /새 버전 받음/);
    assert.match(t.log(), /업데이트 완료/);

    // 다시 실행하면 할 일 없음
    t.clearCalls();
    assert.equal(t.run().status, 0);
    assert.equal(t.calls(), '');
  } finally {
    t.cleanup();
  }
});

test('자동 업데이트: 빌드 실패 → 이전 버전 유지, 1시간 동안 재시도 안 함, --force 는 즉시 재시도', () => {
  const t = setup();
  try {
    const v1 = t.head();
    const v2 = t.release(2);
    fs.writeFileSync(path.join(t.root, 'fail-build'), '');
    let r = t.run();
    assert.equal(r.status, 1);
    assert.equal(t.head(), v1, '코드도 이전 버전으로 되돌림');
    assert.match(t.log(), /빌드 실패/);
    assert.equal(fs.readFileSync(path.join(t.root, 'state', 'failed'), 'utf8').split(' ')[0], v2);

    fs.rmSync(path.join(t.root, 'fail-build'));
    t.clearCalls();
    r = t.run();
    assert.equal(r.status, 0);
    assert.equal(t.calls(), '', '실패한 버전은 바로 다시 시도하지 않음');
    assert.equal(t.head(), v1);

    r = t.run('--force');
    assert.equal(r.status, 0, r.stdout);
    assert.equal(t.head(), v2);
    assert.ok(!fs.existsSync(path.join(t.root, 'state', 'failed')));

    // 더 새 버전이 올라오면 기다리지 않고 시도
    fs.writeFileSync(path.join(t.root, 'fail-build'), '');
    const v3 = t.release(3);
    assert.equal(t.run().status, 1);
    fs.rmSync(path.join(t.root, 'fail-build'));
    const v4 = t.release(4);
    assert.equal(t.run().status, 0);
    assert.equal(t.head(), v4);
    assert.notEqual(v3, v4);
  } finally {
    t.cleanup();
  }
});

test('자동 업데이트: 새 버전이 정상 시작 안 되면 이전 버전으로 되돌려 다시 빌드', () => {
  const t = setup();
  try {
    const v1 = t.head();
    t.release(2);
    fs.writeFileSync(path.join(t.root, 'fail-health'), '');
    const r = t.run();
    assert.equal(r.status, 1);
    assert.equal(t.head(), v1);
    const builds = t.calls().split('\n').filter((l) => l.startsWith('docker compose up')).length;
    assert.equal(builds, 2, '새 버전 빌드 + 이전 버전으로 다시 빌드');
    assert.match(t.log(), /정상적으로 시작되지 않음/);
    assert.match(t.log(), /이전 버전\(.{7}\)으로 되돌렸습니다/);
  } finally {
    t.cleanup();
  }
});

test('자동 업데이트: 서버에서 직접 고친 코드는 덮어쓰지 않음', () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.server, 'orderhub', 'local.txt'), 'x');
    t.git(t.server, 'add', '.');
    t.git(t.server, 'commit', '-q', '-m', 'local change');
    const mine = t.head();
    t.release(2);
    const r = t.run();
    assert.equal(r.status, 0);
    assert.equal(t.head(), mine);
    assert.doesNotMatch(t.calls(), /compose up/);
    assert.match(t.log(), /직접 수정됨/);
  } finally {
    t.cleanup();
  }
});

test('자동 업데이트 켜기: 5분 타이머 등록 + 지금 바로 다시 빌드', () => {
  const t = setup();
  try {
    const units = path.join(t.root, 'units');
    fs.mkdirSync(units);
    const r = spawnSync('bash', [path.join(t.server, 'orderhub', 'scripts', 'enable-auto-update.sh')], { env: { ...t.env, ORDERHUB_SYSTEMD_DIR: units }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /자동 업데이트를 켰습니다/);
    const svc = fs.readFileSync(path.join(units, 'orderhub-update.service'), 'utf8');
    const appDir = fs.realpathSync(path.join(t.server, 'orderhub'));
    assert.ok(svc.includes(`WorkingDirectory=${appDir}`), svc);
    assert.ok(svc.includes(`${appDir}/scripts/auto-update.sh`));
    assert.match(fs.readFileSync(path.join(units, 'orderhub-update.timer'), 'utf8'), /OnUnitActiveSec=5min/);
    assert.match(t.calls(), /systemctl enable --now orderhub-update.timer/);
    assert.match(t.calls(), /systemd-run --unit=orderhub-rebuild-\d+ .*auto-update.sh --force/);

    t.clearCalls();
    const r2 = spawnSync('bash', [path.join(t.server, 'orderhub', 'scripts', 'enable-auto-update.sh')], { env: { ...t.env, ORDERHUB_SYSTEMD_DIR: units, ORDERHUB_NO_REBUILD: '1' }, encoding: 'utf8' });
    assert.equal(r2.status, 0);
    assert.doesNotMatch(t.calls(), /systemd-run/);
  } finally {
    t.cleanup();
  }
});
