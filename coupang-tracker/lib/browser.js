// 실제 브라우저(크롬/엣지)를 자동으로 조작해 가격을 읽는다.
// - 빠른 요청이 쿠팡에 차단될 때 쓰는 대체 수단
// - 로그인된 브라우저 프로필로 장바구니를 읽는 데 쓴다
import { extractPage } from './extractor.js';
import { CART_URL, LOGIN_URL, BlockedError, productPageUrl, parseProductUrl } from './coupang.js';

const firstLine = (e) => String((e && e.message) || e || '').split('\n')[0].slice(0, 200);

export class NeedLoginError extends Error {
  constructor() {
    super('쿠팡 로그인이 필요해요. 설정에서 "쿠팡 로그인 창 열기"를 눌러 로그인해 주세요.');
    this.name = 'NeedLoginError';
    this.needLogin = true;
  }
}

export class BrowserManager {
  constructor({ profileDir, getSettings, onChange = () => {} }) {
    this.profileDir = profileDir;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.ctx = null;
    this.ctxHeadless = null;
    this.channelUsed = null;
    this.loginOpen = false;
    this.lastError = null;
    this._queue = Promise.resolve();
  }

  status() {
    return { channel: this.channelUsed, loginOpen: this.loginOpen, lastError: this.lastError, running: Boolean(this.ctx) };
  }

  _lock(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async _launch({ headless }) {
    let chromium;
    try {
      ({ chromium } = await import('playwright-core'));
    } catch {
      throw new Error('브라우저 자동화 모듈(playwright-core)이 없어요. 이 폴더에서 "npm install"을 실행해 주세요.');
    }
    const s = this.getSettings();
    const custom = process.env.CPT_BROWSER_PATH;
    const channels = custom ? ['custom'] : s.browserChannel === 'auto' ? ['chrome', 'msedge', 'chromium'] : [s.browserChannel];
    let lastErr = null;
    for (const ch of channels) {
      const opts = {
        headless,
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
        viewport: { width: 1280, height: 900 },
      };
      if (custom) opts.executablePath = custom;
      else if (ch !== 'chromium') opts.channel = ch;
      try {
        const ctx = await chromium.launchPersistentContext(this.profileDir, opts);
        this.channelUsed = ch;
        this.lastError = null;
        return ctx;
      } catch (e) {
        lastErr = e;
        if (/already in use|ProcessSingleton|SingletonLock/i.test(String(e.message))) break;
      }
    }
    const msg = /already in use|ProcessSingleton|SingletonLock/i.test(String(lastErr && lastErr.message))
      ? '가격 확인용 브라우저가 이미 다른 곳에서 열려 있어요. 열린 창을 닫고 다시 시도해 주세요.'
      : `브라우저를 실행하지 못했어요. 크롬이나 엣지가 설치돼 있는지 확인하거나 "npx playwright-core install chromium"을 실행해 주세요. (${firstLine(lastErr)})`;
    this.lastError = msg;
    throw new Error(msg);
  }

  async _closeCtx() {
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  _withPage(fn) {
    return this._lock(async () => {
      if (this.loginOpen) throw new Error('쿠팡 로그인 창이 열려 있어요. 로그인을 마치고 창을 닫으면 다시 확인해요.');
      const headless = this.getSettings().browserMode !== 'window';
      if (this.ctx && this.ctxHeadless !== headless) await this._closeCtx();
      if (!this.ctx) {
        const ctx = await this._launch({ headless });
        this.ctx = ctx;
        this.ctxHeadless = headless;
        ctx.on('close', () => { if (this.ctx === ctx) this.ctx = null; });
        this.onChange();
      }
      const page = await this.ctx.newPage();
      try {
        return await fn(page);
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  /** 창 없는 모드라면 한 바퀴 확인이 끝난 뒤 브라우저를 닫아 메모리를 돌려준다. */
  idle() {
    return this._lock(async () => {
      if (this.ctx && this.ctxHeadless) { await this._closeCtx(); this.onChange(); }
    });
  }

  close() {
    return this._lock(() => this._closeCtx());
  }

  async _settle(page) {
    await page.waitForFunction(() => /\d\s*원/.test((document.body && document.body.innerText) || ''), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  async _checkBlocked(page, resp) {
    const status = resp ? resp.status() : 0;
    const title = await page.title().catch(() => '');
    if (status === 403 || status === 429 || /Access Denied/i.test(title)) {
      throw new BlockedError('쿠팡이 자동 브라우저 접속도 막았어요. 설정에서 "브라우저 창 보이기"로 바꿔 보세요.');
    }
    return status;
  }

  checkProduct(product) {
    return this._withPage(async (page) => {
      const resp = await page.goto(productPageUrl(product), { waitUntil: 'domcontentloaded', timeout: 45000 });
      const status = await this._checkBlocked(page, resp);
      if (status === 404) throw new Error('상품 페이지가 없어요 (판매 종료 또는 잘못된 링크).');
      await this._settle(page);
      const r = await page.evaluate(extractPage);
      const item = r.items[0];
      if (!item || !item.price) throw new Error('페이지에서 가격을 찾지 못했어요. 쿠팡 페이지 구조가 바뀌었을 수 있어요.');
      return { name: item.name, image: item.image, price: item.price, soldOut: item.soldOut, strategy: item.how };
    });
  }

  /** 짧은 공유 링크(link.coupang.com)를 브라우저로 열어 실제 상품 주소를 얻는다. */
  resolveUrl(url) {
    return this._withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(800);
      return parseProductUrl(page.url());
    });
  }

  syncCart() {
    return this._withPage(async (page) => {
      const resp = await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this._checkBlocked(page, resp);
      const u = new URL(page.url());
      if (/login/i.test(u.hostname + u.pathname)) throw new NeedLoginError();
      await this._settle(page);
      const r = await page.evaluate(extractPage);
      return r.items;
    });
  }

  /** 사용자가 직접 로그인할 수 있도록 브라우저 창을 띄운다. 창을 닫으면 끝. */
  async openLogin() {
    if (this.loginOpen) return;
    await this._lock(() => this._closeCtx());
    this.loginOpen = true;
    this.onChange();
    let ctx;
    try {
      ctx = await this._launch({ headless: false });
    } catch (e) {
      this.loginOpen = false;
      this.onChange();
      throw e;
    }
    (async () => {
      try {
        const page = ctx.pages()[0] || await ctx.newPage();
        page.on('close', () => { ctx.close().catch(() => {}); });
        await page.goto(LOGIN_URL, { timeout: 45000 }).catch(() => {});
        await new Promise((resolve) => {
          ctx.on('close', resolve);
          setTimeout(resolve, 15 * 60 * 1000); // 15분이 지나면 자동으로 닫는다
        });
      } finally {
        await ctx.close().catch(() => {});
        this.loginOpen = false;
        this.onChange();
      }
    })();
  }
}
