const BASE_URL = "https://jilhub.org/";
const SEARCH_URL_TEMPLATE = (q) => `https://jilhub.org/?s=${encodeURIComponent(q)}`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE_URL,
  "Cache-Control": "no-cache"
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function decodeHtml(str = "") {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&hellip;|&#8230;/gi, "…")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

function stripTags(html = "") {
  return decodeHtml(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function isAllowedTarget(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    return u.hostname === "jilhub.org" || u.hostname.endsWith(".jilhub.org");
  } catch (_) {
    return false;
  }
}

function isJunkPageUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return /\/(?:tags?|categories?|category|models?|channels?|authors?|search)\//i.test(u.pathname);
  } catch (_) {
    return true;
  }
}

function resolveUrl(raw, base) {
  if (!raw || raw.startsWith("data:") || raw.startsWith("javascript:") || raw.startsWith("#")) {
    return null;
  }
  try {
    return new URL(decodeHtml(raw).trim(), base).toString();
  } catch (_) {
    return null;
  }
}

async function fetchHtml(targetUrl, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(targetUrl, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Upstream HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseSearchResults(html, baseUrl) {
  const results = [];
  const seen = new Set();

  const articleRegex = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  for (const art of html.matchAll(articleRegex)) {
    const block = art[1];
    const linkMatch = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = resolveUrl(linkMatch[1], baseUrl);
    if (!url || !isAllowedTarget(url) || isJunkPageUrl(url) || seen.has(url)) continue;

    const titleAttr = block.match(/title=["']([^"']+)["']/i);
    const headingMatch = block.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
    const title =
      (headingMatch ? stripTags(headingMatch[1]) : "") ||
      (titleAttr ? decodeHtml(titleAttr[1]).trim() : "") ||
      stripTags(linkMatch[2]);

    const imgMatch = block.match(/<img\b[^>]*(?:data-src|data-lazy-src|src)=["']([^"']+)["'][^>]*>/i);
    const thumbnail = imgMatch ? resolveUrl(imgMatch[1], baseUrl) : null;

    if (title && title.length > 1) {
      seen.add(url);
      results.push({ title, url, thumbnail });
    }
  }

  if (results.length === 0) {
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = resolveUrl(m[1], baseUrl);
      if (!url || !isAllowedTarget(url) || isJunkPageUrl(url) || seen.has(url)) continue;

      const u = new URL(url);
      if (u.pathname === "/" || u.pathname.startsWith("/wp-") || u.searchParams.has("s")) continue;

      const title = stripTags(m[2]);
      if (!title || title.length < 2) continue;

      seen.add(url);
      results.push({ title, url, thumbnail: null });
    }
  }

  return results;
}

function parseItemInfoAndDownloads(html, pageUrl) {
  const titleMatch =
    html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const descMatch =
    html.match(/<meta\b[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);

  const videoPosterMatch = html.match(/<video\b[^>]*poster=["']([^"']+)["'][^>]*>/i);
  const ogImageMatch = html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  const firstImgMatch = html.match(/<img\b[^>]*(?:data-src|src)=["']([^"']+)["'][^>]*>/i);

  const image =
    (videoPosterMatch ? resolveUrl(videoPosterMatch[1], pageUrl) : null) ||
    (ogImageMatch ? resolveUrl(ogImageMatch[1], pageUrl) : null) ||
    (firstImgMatch ? resolveUrl(firstImgMatch[1], pageUrl) : null);

  const embeds = new Set();
  const streams = new Set();
  const downloads = [];
  const seenDl = new Set();

  for (const m of html.matchAll(/<iframe\b[^>]*(?:data-src|src)=["']([^"']+)["'][^>]*>/gi)) {
    const u = resolveUrl(m[1], pageUrl);
    if (u) embeds.add(u);
  }

  for (const m of html.matchAll(/<(?:video|source)\b[^>]*(?:data-src|src)=["']([^"']+)["'][^>]*>/gi)) {
    const u = resolveUrl(m[1], pageUrl);
    if (u) streams.add(u);
  }

  // Extract media stream links from HTML and inline JS/JSON configs
  const mediaRegex = /https?:\/\/[^\s"'<>\\)]+\.(?:mp4|m3u8|mpd|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const m of html.matchAll(mediaRegex)) {
    const cleanMedia = decodeHtml(m[0]).replace(/\\\//g, "/");
    streams.add(cleanMedia);
  }

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = resolveUrl(m[1], pageUrl);
    const label = stripTags(m[2]) || "Download";
    if (!u || seenDl.has(u)) continue;

    // Skip tag, category, model, author, and internal video page links
    if (isJunkPageUrl(u) || /\/videos\/\d+\//i.test(u) || u === pageUrl || u === BASE_URL) {
      continue;
    }

    const isDirectMedia = /\.(?:mp4|mkv|webm|avi|mov|zip|rar|7z)(?:\?|$)/i.test(u);
    const isFileDownloadUrl =
      /(?:get_file|download\.php|\/dl\/|cdn|storage|file)/i.test(u) &&
      !/jilhub\.org/i.test(new URL(u).hostname);

    if (isDirectMedia || isFileDownloadUrl) {
      seenDl.add(u);
      downloads.push({ label, url: u });
    }
  }

  return {
    title: titleMatch ? stripTags(titleMatch[1]) : null,
    description: descMatch ? decodeHtml(descMatch[1]).trim() : null,
    image,
    embeds: [...embeds],
    streams: [...streams],
    downloads
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, 200);
    }
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    const urlObj = new URL(request.url);
    const path = urlObj.pathname;

    if (path === "/health") {
      return jsonResponse({
        ok: true,
        endpoints: ["/search?q=keyword", "/info?url=...", "/download?url=..."]
      });
    }

    if (path === "/search") {
      const q = (urlObj.searchParams.get("q") || "").trim();
      if (!q) {
        return jsonResponse({ ok: false, error: "Missing ?q=keyword" }, 400);
      }

      try {
        const searchUrl = SEARCH_URL_TEMPLATE(q);
        const html = await fetchHtml(searchUrl);
        const items = parseSearchResults(html, searchUrl);
        return jsonResponse({
          ok: true,
          query: q,
          source: searchUrl,
          total: items.length,
          items
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message || "Search failed" }, 500);
      }
    }

    if (path === "/info" || path === "/download") {
      const target = urlObj.searchParams.get("url");
      if (!target || !isAllowedTarget(target)) {
        return jsonResponse({ ok: false, error: "Pass valid ?url=https://jilhub.org/..." }, 400);
      }

      try {
        const html = await fetchHtml(target);
        const info = parseItemInfoAndDownloads(html, target);

        if (path === "/download") {
          return jsonResponse({
            ok: true,
            url: target,
            title: info.title,
            image: info.image,
            streams: info.streams,
            embeds: info.embeds,
            downloads: info.downloads
          });
        }

        return jsonResponse({
          ok: true,
          url: target,
          ...info
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message || "Fetch failed" }, 500);
      }
    }

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
        endpoints: ["/search?q=keyword", "/info?url=...", "/download?url=...", "/health"]
      },
      404
    );
  }
};
