// Page fetcher: plain HTTP by default; headless Chromium (Playwright) when
// USE_BROWSER=1 and the page needs JavaScript to show its prices.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 DiscountAggregatorBot/1.0 (+https://github.com/bennygoldstein/discount-aggregator)";

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({ headless: true });
    })();
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      /* ignore */
    }
    browserPromise = null;
  }
}

/** Strip tags/scripts to readable text. Keeps JSON blobs (they often hold prices). */
export function htmlToText(html) {
  if (!html) return "";
  let s = html
    .replace(/<script[^>]*type=["']application\/(ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi, "\n$2\n")
    .replace(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/gi, "\n$1\n")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|section|article|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n");
  return s.trim();
}

async function fetchPlain(url, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      redirect: "follow",
      signal: ctl.signal,
    });
    const html = await res.text();
    return { status: res.status, html, text: htmlToText(html), rendered: false, url: res.url || url };
  } finally {
    clearTimeout(t);
  }
}

async function fetchRendered(url, timeoutMs = 45000) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs }).catch(() => null);
    await page.waitForTimeout(1500);
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText || "");
    return { status: res ? res.status() : 0, html, text: text || htmlToText(html), rendered: true, url: page.url() };
  } finally {
    await ctx.close();
  }
}

/**
 * Fetch a page. `render` asks for a headless browser when USE_BROWSER=1;
 * falls back to plain HTTP if Playwright is not installed.
 */
export async function fetchPage(url, { render = false } = {}) {
  const wantBrowser = render && process.env.USE_BROWSER === "1";
  if (wantBrowser) {
    try {
      return await fetchRendered(url);
    } catch (e) {
      console.warn(`  [fetch] browser render failed for ${url}: ${e.message}. Falling back to plain HTTP.`);
    }
  }
  return fetchPlain(url);
}

/** POST JSON helper (used for Atlas Cloud's free quote endpoint). */
export async function postJson(url, body, headers = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA, ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}
