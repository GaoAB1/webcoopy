import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '../src/adapters.js';
import { githubReadmeAdapter, toRawUrl } from '../src/adapters/github-readme.js';
import { zhihuAdapter } from '../src/adapters/zhihu.js';
import { wechatAdapter } from '../src/adapters/wechat.js';
import { juejinAdapter } from '../src/adapters/juejin.js';

describe('AdapterRegistry', () => {
  it('returns matching adapters in registration order', () => {
    const r = new AdapterRegistry()
      .register({ name: 'a', description: 'a', match: (u) => u.includes('x'), extract: () => ({}) })
      .register({ name: 'b', description: 'b', match: (u) => u.includes('x') && u.includes('y'), extract: () => ({}) });
    const found = r.findFor('https://example.com/x/y');
    expect(found.map((a) => a.name)).toEqual(['a', 'b']);
  });

  it('filters out non-matching adapters', () => {
    const r = new AdapterRegistry()
      .register({ name: 'gh', description: 'gh', match: () => true, extract: () => ({}) })
      .register({ name: 'zz', description: 'zz', match: () => false, extract: () => ({}) });
    const found = r.findFor('https://example.com/');
    expect(found.map((a) => a.name)).toEqual(['gh']);
  });

  it('survives an adapter match() throwing', () => {
    const r = new AdapterRegistry()
      .register({ name: 'bad', description: 'bad', match: () => { throw new Error('boom'); }, extract: () => ({}) });
    expect(() => r.findFor('https://example.com/')).not.toThrow();
    expect(r.findFor('https://example.com/')).toHaveLength(0);
  });
});

describe('githubReadmeAdapter', () => {
  it('matches github.com/owner/repo/blob/… URLs', () => {
    expect(githubReadmeAdapter.match('https://github.com/owner/repo/blob/main/README.md')).toBe(true);
  });

  it('matches bare github.com/owner/repo URLs', () => {
    expect(githubReadmeAdapter.match('https://github.com/owner/repo')).toBe(true);
  });

  it('rejects unrelated URLs', () => {
    expect(githubReadmeAdapter.match('https://example.com/')).toBe(false);
    expect(githubReadmeAdapter.match('https://gitlab.com/owner/repo')).toBe(false);
  });

  it('toRawUrl converts blob URL to raw.githubusercontent URL', () => {
    expect(toRawUrl('https://github.com/owner/repo/blob/main/README.md'))
      .toBe('https://raw.githubusercontent.com/owner/repo/main/README.md');
  });

  it('toRawUrl uses "main" as default ref when the URL has no /blob/', () => {
    expect(toRawUrl('https://github.com/owner/repo'))
      .toBe('https://raw.githubusercontent.com/owner/repo/main/README.md');
  });

  it('toRawUrl preserves subdirectory paths', () => {
    expect(toRawUrl('https://github.com/owner/repo/blob/master/docs/GUIDE.md'))
      .toBe('https://raw.githubusercontent.com/owner/repo/master/docs/GUIDE.md');
  });

  it('toRawUrl strips query strings and anchors', () => {
    expect(toRawUrl('https://github.com/owner/repo/blob/main/README.md#section-1'))
      .toBe('https://raw.githubusercontent.com/owner/repo/main/README.md');
  });

  it('toRawUrl returns null for non-github URLs', () => {
    expect(toRawUrl('https://example.com/foo/bar')).toBe(null);
  });

  it('extract returns the fetched markdown as-is (bypass converter)', async () => {
    const md = '# My README\n\nSome **bold** text.';
    const r = await githubReadmeAdapter.extract('https://github.com/o/r', md, 'https://raw.githubusercontent.com/o/r/main/README.md');
    expect(r.markdown).toBe(md);
    expect(r.siteName).toBe('github');
  });

  it('resolveFetchUrl returns the raw URL', () => {
    const raw = githubReadmeAdapter.resolveFetchUrl?.('https://github.com/o/r/blob/main/README.md');
    expect(raw).toBe('https://raw.githubusercontent.com/o/r/main/README.md');
  });
});

describe('zhihuAdapter', () => {
  it('matches /question/{id}/answer/{id} URLs', () => {
    expect(zhihuAdapter.match('https://www.zhihu.com/question/12345/answer/67890')).toBe(true);
  });

  it('matches /p/{id} article URLs', () => {
    expect(zhihuAdapter.match('https://www.zhihu.com/p/987654321')).toBe(true);
  });

  it('matches /answer/{id} URLs', () => {
    expect(zhihuAdapter.match('https://zhihu.com/answer/12345')).toBe(true);
  });

  it('rejects unrelated URLs', () => {
    expect(zhihuAdapter.match('https://www.zhihu.com/')).toBe(false);
    expect(zhihuAdapter.match('https://www.zhihu.com/topic/123')).toBe(false);
    expect(zhihuAdapter.match('https://example.com/')).toBe(false);
  });

  it('extract pulls title, byline, and body from a real-shaped answer HTML', async () => {
    const html = `
<html>
<head><title>我的回答 - 知乎</title></head>
<body>
<div class="Question">
  <h1>什么是 webcopy？</h1>
</div>
<div class="AnswerCard">
  <div class="AuthorInfo">
    <a href="/users/jane"><span class="AvatarLink">Jane</span></a>
  </div>
  <div class="RichContent RichContent--medium QuestionRichText" id="content">
    <p>Webcopy is a tool.</p>
    <p>It converts <a href="https://example.com">articles</a> to markdown.</p>
    <pre><code class="language-js">console.log('hi');</code></pre>
    <img data-src="https://pic.zhihu.com/x.png" alt="screenshot">
    <p>More details here.</p>
  </div>
  <div class="VoteButton">upvote</div>
</div>
</body>
</html>`;

    const r = await zhihuAdapter.extract('https://www.zhihu.com/question/1/answer/2', html, 'https://www.zhihu.com/question/1/answer/2');
    expect(r.title).toContain('webcopy');
    expect(r.siteName).toBe('zhihu');
    expect(r.html).toBeDefined();
    expect(r.html).toContain('console.log');
    expect(r.html).toContain('src="https://pic.zhihu.com/x.png"');
    // Vote button should be stripped.
    expect(r.html).not.toContain('VoteButton');
  });

  it('extract returns { html: undefined } when no container is found', async () => {
    const html = '<html><body><p>unrelated</p></body></html>';
    const r = await zhihuAdapter.extract('https://www.zhihu.com/question/1/answer/2', html, 'https://www.zhihu.com/question/1/answer/2');
    expect(r.html).toBeUndefined();
  });

  it('extract removes empty anchor elements', async () => {
    const html = `
<div class="RichContent RichContent--medium QuestionRichText">
<p>Some content that is long enough to be considered substantial by the adapter logic.</p>
<p>More content here to make sure the length threshold is exceeded by this paragraph of text.</p>
<p>Even more filler content to ensure we pass the 200 character threshold in the body extraction.</p>
<a href="#" class="Link--primary"></a>
</div>`;
    const r = await zhihuAdapter.extract('https://www.zhihu.com/question/1/answer/2', html, 'https://www.zhihu.com/question/1/answer/2');
    expect(r.html).toBeDefined();
    expect(r.html).not.toMatch(/<a[^>]*>\s*<\/a>/);
  });
});

describe('wechatAdapter', () => {
  it('matches mp.weixin.qq.com/s/* URLs', () => {
    expect(wechatAdapter.match('https://mp.weixin.qq.com/s/abc123')).toBe(true);
    expect(wechatAdapter.match('https://mp.weixin.qq.com/s/abc123?scene=1')).toBe(true);
  });

  it('rejects non-wechat URLs', () => {
    expect(wechatAdapter.match('https://mp.weixin.qq.com/profile')).toBe(false);
    expect(wechatAdapter.match('https://example.com/')).toBe(false);
  });

  it('extract pulls title, author, and body from #js_content', async () => {
    const html = `
<html>
<head><title>测试文章 - 微信</title></head>
<body>
<h1 id="activity-name" class="rich_media_title">这是我的微信公众号文章</h1>
<div id="js_author_name">作者小明</div>
<div id="js_content">
  <p>这是正文第一段。</p>
  <p>这是正文第二段。</p>
  <img data-src="https://mmbiz.qpic.cn/xxx.jpg" src="data:image/svg+xml;base64,AAA">
  <pre><code class="language-js">console.log('wechat');</code></pre>
  <blockquote>引用内容</blockquote>
  <section>更多内容，这段文字足够长，用来确保适配器能识别出足够的正文长度阈值。</section>
  <section>更多段落内容填充，让适配器能稳定识别出正文。</section>
  <section>最后一段正文内容，包含一些额外的字符。</section>
</div>
<div class="js_pc_qr_code">二维码</div>
<div class="js_share_button">分享</div>
</body>
</html>`;
    const r = await wechatAdapter.extract('https://mp.weixin.qq.com/s/abc123', html, 'https://mp.weixin.qq.com/s/abc123');
    expect(r.title).toContain('微信公众号');
    expect(r.byline).toContain('作者小明');
    expect(r.siteName).toBe('wechat');
    expect(r.html).toBeDefined();
    expect(r.html).toContain('正文第一段');
    expect(r.html).toContain('console.log');
    // Lazy-loaded image rewritten.
    expect(r.html).toContain('https://mmbiz.qpic.cn/xxx.jpg');
    // Noise stripped.
    expect(r.html).not.toContain('js_pc_qr_code');
    expect(r.html).not.toContain('js_share_button');
  });

  it('extract returns { html: undefined } when #js_content is missing', async () => {
    const html = '<html><body><p>unrelated</p></body></html>';
    const r = await wechatAdapter.extract('https://mp.weixin.qq.com/s/abc123', html, 'https://mp.weixin.qq.com/s/abc123');
    expect(r.html).toBeUndefined();
  });
});

describe('juejinAdapter', () => {
  it('matches juejin.cn/post/* URLs', () => {
    expect(juejinAdapter.match('https://juejin.cn/post/123456789')).toBe(true);
  });

  it('rejects non-juejin URLs', () => {
    expect(juejinAdapter.match('https://juejin.cn/user/123')).toBe(false);
    expect(juejinAdapter.match('https://example.com/')).toBe(false);
  });

  it('extract pulls title, author, and body from .article-content', async () => {
    const html = `
<html>
<head><title>掘金文章 - 掘金</title></head>
<body>
<div class="article-container">
  <h1>掘金文章标题</h1>
  <div class="daohang-author-name">作者小王</div>
  <div class="article-content">
    <p>这是掘金正文第一段。</p>
    <p>这是掘金正文第二段。</p>
    <pre><code class="language-js">console.log('juejin');</code></pre>
    <img src="https://p3-jj.byteimg.com/xxx.jpg" alt="示意图">
    <p>更多正文内容，用来确保适配器能识别出足够的正文长度阈值。</p>
    <p>更多段落内容填充，让适配器能稳定识别出正文。</p>
    <p>最后一段正文内容，包含一些额外的字符。</p>
  </div>
  <div class="comment-container">评论列表</div>
  <div class="like-button">点赞</div>
</div>
</body>
</html>`;
    const r = await juejinAdapter.extract('https://juejin.cn/post/123456789', html, 'https://juejin.cn/post/123456789');
    expect(r.title).toContain('掘金文章');
    expect(r.byline).toContain('作者小王');
    expect(r.siteName).toBe('juejin');
    expect(r.html).toBeDefined();
    expect(r.html).toContain('掘金正文第一段');
    expect(r.html).toContain('console.log');
    expect(r.html).toContain('https://p3-jj.byteimg.com/xxx.jpg');
    // Noise stripped.
    expect(r.html).not.toContain('comment-container');
    expect(r.html).not.toContain('like-button');
  });

  it('extract strips common suffix from title', async () => {
    const html = `
<html>
<head><title>某文章 - 掘金</title></head>
<body>
<article>
  <p>这是正文内容，用来确保适配器能识别出足够的正文长度阈值。这段文字足够长。</p>
  <p>更多段落内容填充，让适配器能稳定识别出正文。再来一些文字凑够阈值。</p>
  <p>最后一段正文内容，包含一些额外的字符。这里再补充一些文字。</p>
  <p>第四段补充内容，确保适配器能识别出足够的正文长度阈值并成功通过。</p>
</article>
</body>
</html>`;
    const r = await juejinAdapter.extract('https://juejin.cn/post/1', html, 'https://juejin.cn/post/1');
    expect(r.title).toBe('某文章');
  });

  it('extract returns { html: undefined } when body is too short', async () => {
    const html = '<html><body><div class="article-content"><p>short</p></div></body></html>';
    const r = await juejinAdapter.extract('https://juejin.cn/post/1', html, 'https://juejin.cn/post/1');
    expect(r.html).toBeUndefined();
  });
});

/**
 * Juejin is a Nuxt SPA: a plain HTTP fetch returns a shell with no
 * `.article-content` element, and the article ships inside the `__NUXT__`
 * payload. Before this was handled, extraction produced an empty body, the
 * pipeline fell through to Readability, and Readability picked up the loading
 * placeholder ("Please wait...") and wrote it as the entire document.
 */
describe('juejinAdapter — Nuxt SSR payload', () => {
  /** Build a payload shaped like Juejin's minified IIFE. */
  function nuxtHtml(markContent: string, title = '示例文章 - 掘金'): string {
    return `<html><head><title>${title}</title></head><body>
<div id="__nuxt"><div class="view-container"></div></div>
<script>window.__NUXT__=(function(a,b,c){return {article:{article_id:"123",article_info:{article_id:"123",mark_content:"${markContent}",user_name:"张三"},theme:a}};})(0,1,2);</script>
</body></html>`;
  }

  it('reads mark_content from the SSR payload and returns it as markdown', async () => {
    const md = '欢迎来到 **热门项目** 排行榜。\\n\\n![图](https://example.com/a.png)';
    const r = await juejinAdapter.extract('https://juejin.cn/post/123', nuxtHtml(md), '');

    expect(r.markdown).toBeDefined();
    expect(r.markdown).toContain('欢迎来到');
    expect(r.markdown).toContain('![图](https://example.com/a.png)');
    // The payload path must bypass the HTML converter entirely.
    expect(r.html).toBeUndefined();
    expect(r.siteName).toBe('juejin');
  });

  it('strips the leading "theme: juejin" front-matter Juejin embeds', async () => {
    const md = '---\\ntheme: juejin\\n---\\n\\n正文从这里开始。';
    const r = await juejinAdapter.extract('https://juejin.cn/post/123', nuxtHtml(md), '');

    expect(r.markdown).toBe('正文从这里开始。');
    expect(r.markdown).not.toContain('theme: juejin');
  });

  it('does not strip a front-matter block that is not the theme header', async () => {
    const md = '---\\ntitle: 自定义\\n---\\n\\n正文。';
    const r = await juejinAdapter.extract('https://juejin.cn/post/123', nuxtHtml(md), '');

    expect(r.markdown).toContain('title: 自定义');
  });

  it('unescapes JS string escapes including \\u002F slashes', async () => {
    const md = '![x](https:\\u002F\\u002Fexample.com\\u002Fimg.png)\\n\\n换行符测试';
    const r = await juejinAdapter.extract('https://juejin.cn/post/123', nuxtHtml(md), '');

    expect(r.markdown).toContain('https://example.com/img.png');
    expect(r.markdown).toContain('\n');
  });

  it('takes the title from <title> without the 掘金 suffix', async () => {
    const r = await juejinAdapter.extract(
      'https://juejin.cn/post/123',
      nuxtHtml('正文内容足够长以通过校验。', '我的掘金文章 - 掘金'),
      ''
    );
    expect(r.title).toBe('我的掘金文章');
  });

  it('does not mistake a nav "title" field for the article title', async () => {
    // The minified payload contains unrelated title fields such as
    // `title:"推荐"` for nav tabs — those must never win.
    const html = `<html><head><title>真实标题 - 掘金</title></head><body>
<script>window.__NUXT__=(function(a){return {category:{list:[{title:"推荐"},{title:"热门"}]},article:{article_info:{mark_content:"正文内容。"}}};})(0);</script>
</body></html>`;
    const r = await juejinAdapter.extract('https://juejin.cn/post/123', html, '');
    expect(r.title).toBe('真实标题');
  });

  it('reads mark_content when the article key is minified to an alias (2026-10 payload shape)', async () => {
    // Real-world shape captured from juejin on 2026-10-03: the IIFE assigns
    // everything to single-letter aliases and `article` never appears as a
    // literal object key, so the `article:{` anchor fails and the adapter must
    // scan the whole payload for `mark_content` instead.
    const md = '---\\ntheme: juejin\\n---\\n\\n欢迎来到 **2026 年 7 月 GitHub 热门项目** 榜单。\\n\\n正文继续。';
    const html = `<html><head><title>🚀 2026 年 7 月 GitHub 十大热门项目排行榜 - 掘金</title></head><body>
<div id="__nuxt"><div class="view-container"></div></div>
<script>window.__NUXT__=(function(a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S){u.loading=a;u.skeleton=d;u.cursor=f;u.data=[];u.total=b;u.hasMore=d;J.id=x;J.self_description=j;J.followed=a;J.viewerIsFollowing=j;J.community=j;J.level=t;J.user_id=x;J.user_name=F;J.company="想自己开个公司";J.job_title="🏆独立开发者";return {user:J,rankList:{list:[{article_id:x,author_user_info:J,rank_index:.05653469,is_hot:b,status:s,verify_status:g,audit_status:s,mark_content:"${md}"}],loading:a,skeleton:d,cursor:f,total:b,hasMore:d},theme:a};})(0,1,2,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38);</script>
</body></html>`;
    const r = await juejinAdapter.extract('https://juejin.cn/post/7668296872551792640', html, '');

    expect(r.markdown).toBeDefined();
    expect(r.markdown).not.toContain('theme: juejin');
    expect(r.markdown).toContain('欢迎来到 **2026 年 7 月 GitHub 热门项目** 榜单。');
    expect(r.title).toBe('🚀 2026 年 7 月 GitHub 十大热门项目排行榜');
    expect(r.siteName).toBe('juejin');
  });

  it('falls back to the DOM path when no payload is present', async () => {
    const html = `<html><head><title>DOM 文章 - 掘金</title></head><body>
<div class="article-content">${'<p>这是一段足够长的正文段落内容，用于通过适配器的最小长度校验。</p>'.repeat(5)}</div>
</body></html>`;
    const r = await juejinAdapter.extract('https://juejin.cn/post/1', html, '');

    expect(r.markdown).toBeUndefined();
    expect(r.html).toBeDefined();
    expect(r.html).toContain('这是一段足够长的正文段落内容');
  });

  it('does not return the loading placeholder as content', async () => {
    // Regression: an SPA shell with no payload must not yield "Please wait...".
    const html = '<html><head><title>x - 掘金</title></head><body><div id="__nuxt"></div></body></html>';
    const r = await juejinAdapter.extract('https://juejin.cn/post/1', html, '');

    expect(r.markdown).toBeUndefined();
    expect(r.html).toBeUndefined();
  });
});

describe('juejinAdapter — degraded-page signal', () => {
  it('flags retryWithBrowser when both payload and DOM extraction fail', async () => {
    // An SPA shell with neither the SSR payload nor a rendered article —
    // the shape juejin serves when it degrades a request.
    const html = '<html><head><title>x - 掘金</title></head><body><div id="__nuxt"></div></body></html>';
    const r = await juejinAdapter.extract('https://juejin.cn/post/1', html, '');

    expect(r.markdown).toBeUndefined();
    expect(r.html).toBeUndefined();
    expect(r.retryWithBrowser).toBe(true);
  });

  it('does not flag retryWithBrowser when the DOM path succeeds', async () => {
    const long = '<p>这是一段足够长的正文段落内容，用于通过适配器的最小长度校验。</p>'.repeat(5);
    const html = `<html><head><title>DOM 文章 - 掘金</title></head><body>
<div class="article-content">${long}</div>
</body></html>`;
    const r = await juejinAdapter.extract('https://juejin.cn/post/1', html, '');

    expect(r.html).toBeDefined();
    expect(r.retryWithBrowser).toBeUndefined();
  });
});
