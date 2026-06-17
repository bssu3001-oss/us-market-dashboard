(function () {
  'use strict';

  const MARKET_DESC = '미국 증시(S&P 500·NASDAQ·다우존스)';
  const MAIN_TICKER_URL = '%5EGSPC';
  const MAIN_TICKER_NAME = 'S&P 500';

  /* ── 프록시 ── */
  async function proxyText(url, timeout = 8000) {
    const proxies = [
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ];
    for (const p of proxies) {
      try {
        const r = await fetch(p, { signal: AbortSignal.timeout(timeout) });
        if (r.ok) return await r.text();
      } catch (_) {}
    }
    return null;
  }

  async function proxyJSON(url, timeout = 8000) {
    const text = await proxyText(url, timeout);
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /* ── Yahoo Finance ── */
  const RANGE_DEFS = {
    d1:  { i: '1d',  r: '5d'  },
    d5:  { i: '1d',  r: '5d'  },
    d30: { i: '1d',  r: '1mo' },
    mo3: { i: '1d',  r: '3mo' },
    mo6: { i: '1wk', r: '6mo' },
    yr1: { i: '1wk', r: '1y'  },
  };

  async function fetchRange(ticker, interval, range, labelMode) {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
    const j = await proxyJSON(url, 9000);
    if (!j || !j.chart || !j.chart.result || !j.chart.result[0]) return null;
    const res = j.chart.result[0];
    const ts = res.timestamp || [];
    const raw = res.indicators.quote[0].close || [];
    const labels = [], prices = [];
    ts.forEach((t, i) => {
      if (raw[i] == null) return;
      const d = new Date(t * 1000);
      const lbl = labelMode === 'time'
        ? `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`
        : `${d.getMonth()+1}/${d.getDate()}`;
      labels.push(lbl);
      prices.push(parseFloat(raw[i].toFixed(2)));
    });
    return { labels, prices, meta: res.meta };
  }

  /* ── 이동평균 ── */
  function calcMA(prices, n) {
    return prices.map((_, i) => {
      if (i < n - 1) return null;
      const s = prices.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0);
      return parseFloat((s / n).toFixed(2));
    });
  }

  /* ── 기술 지표 ── */
  function updateTechnicals(meta, weeklyPrices) {
    const n = weeklyPrices.length;
    if (n < 6) return;

    // RSI 14주
    let gains = 0, losses = 0;
    for (let i = Math.max(1, n - 14); i < n; i++) {
      const d = weeklyPrices[i] - weeklyPrices[i - 1];
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
    const periods = Math.min(14, n - 1);
    const avgG = gains / periods, avgL = losses / periods;
    const rsi = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);

    // 이평선
    const cur = weeklyPrices[n - 1];
    const ma5  = n >= 5  ? weeklyPrices.slice(-5).reduce((a,b)=>a+b)/5   : null;
    const ma13 = n >= 13 ? weeklyPrices.slice(-13).reduce((a,b)=>a+b)/13 : null;
    const ma26 = n >= 26 ? weeklyPrices.slice(-26).reduce((a,b)=>a+b)/26 : null;

    // 4주 모멘텀
    const mom4 = n >= 5 ? (weeklyPrices[n-1] - weeklyPrices[n-5]) / weeklyPrices[n-5] * 100 : null;

    // 52주 위치
    const hi52 = meta.fiftyTwoWeekHigh || Math.max(...weeklyPrices.slice(-52));
    const lo52 = meta.fiftyTwoWeekLow  || Math.min(...weeklyPrices.slice(-52));
    const fromHi = hi52 ? (cur - hi52) / hi52 * 100 : null;
    const fromLo = lo52 ? (cur - lo52) / lo52 * 100 : null;

    // RSI 배지
    const rsiClass = rsi <= 40 ? 'badge-g' : rsi >= 70 ? 'badge-r' : 'badge-y';
    setBadge('badge-rsi', `RSI ${rsi.toFixed(0)} — ${rsi<=30?'심한 과매도':rsi<=40?'과매도':rsi>=70?'과매수':rsi>=60?'과열 주의':'중립'}`, rsiClass);

    // 이평선 배지
    let maText = '혼조', maClass = 'badge-y';
    if (ma5 && ma13 && ma26) {
      if (cur>ma5 && ma5>ma13 && ma13>ma26) { maText='정배열(상승)'; maClass='badge-g'; }
      else if (cur<ma5 && ma5<ma13 && ma13<ma26) { maText='역배열(하락)'; maClass='badge-r'; }
      else if (cur>ma5 && cur>ma13) { maText='단기 상승'; maClass='badge-y'; }
      else if (cur<ma5 && cur<ma13) { maText='단기 하락'; maClass='badge-y'; }
    } else if (ma5 && ma13) {
      if (cur>ma5 && ma5>ma13) { maText='단기 정배열'; maClass='badge-g'; }
      else if (cur<ma5 && ma5<ma13) { maText='단기 역배열'; maClass='badge-r'; }
    }
    setBadge('badge-ma', maText, maClass);

    // 모멘텀 배지
    if (mom4 != null) {
      const mc = mom4 > 2 ? 'badge-g' : mom4 < -2 ? 'badge-r' : 'badge-y';
      setBadge('badge-mom', `${mom4>=0?'▲':'▼'} ${Math.abs(mom4).toFixed(1)}% (4주 변화)`, mc);
    }

    // 52주 위치 배지
    if (fromHi != null) {
      const pc = fromHi > -5 ? 'badge-r' : fromHi > -15 ? 'badge-y' : 'badge-g';
      setBadge('badge-pos', `고점 대비 ${fromHi.toFixed(1)}% / 저점 대비 +${fromLo!=null?fromLo.toFixed(1):'--'}%`, pc);
    }

    if (typeof recalcScorecard === 'function') recalcScorecard();
    return { rsi, ma5, ma13, ma26, mom4, fromHi, fromLo, cur };
  }

  /* ── AI 차트 분석 카드 ── */
  function buildAnalysis(name, weekly, d5prices, meta, scale) {
    const n = weekly.length;
    if (n < 2) return;
    const cur = weekly[n-1];
    const prev = weekly[n-2];
    const pct1w = ((cur - prev) / prev * 100).toFixed(2);
    const ma5  = n>=5  ? (weekly.slice(-5).reduce((a,b)=>a+b)/5).toFixed(2) : null;
    const ma13 = n>=13 ? (weekly.slice(-13).reduce((a,b)=>a+b)/13).toFixed(2) : null;
    const mom4 = n>=5  ? ((cur - weekly[n-5]) / weekly[n-5] * 100).toFixed(2) : null;
    const hi52 = meta?.fiftyTwoWeekHigh || Math.max(...weekly.slice(-52));
    const fromHi = hi52 ? ((cur - hi52) / hi52 * 100).toFixed(1) : null;

    let maState = '혼조';
    if (ma5 && ma13) maState = +cur > +ma5 && +ma5 > +ma13 ? '정배열(상승 추세)' : +cur < +ma5 && +ma5 < +ma13 ? '역배열(하락 추세)' : '혼조';

    const d5last = d5prices && d5prices.length >= 2 ? d5prices[d5prices.length-1] : null;
    const d5prev = d5prices && d5prices.length >= 2 ? d5prices[d5prices.length-2] : null;
    const d5pct  = (d5last && d5prev) ? ((d5last - d5prev) / d5prev * 100).toFixed(2) : null;

    const el = document.getElementById('ai-chart-analysis');
    if (!el) return;
    el.textContent = [
      `• 현재 지수: ${(cur).toLocaleString()} (주간 ${+pct1w>=0?'▲+':'▼'}${pct1w}%) — ${+pct1w>1?'주간 상승':+pct1w<-1?'주간 하락':'보합'}`,
      `• 추세 (이평): ${maState} / MA5 ${ma5?ma5.toLocaleString():'N/A'} / MA13 ${ma13?ma13.toLocaleString():'N/A'}`,
      `• 모멘텀: 4주 ${mom4!=null?(+mom4>=0?'▲+':'▼')+mom4+'%':'N/A'} / 52주 고점 대비 ${fromHi!=null?fromHi+'%':'N/A'}`,
      d5pct ? `• 최근 일봉: 전일 대비 ${+d5pct>=0?'▲+':'▼'}${d5pct}%` : '',
      `• 한 줄 결론: ${maState.includes('정배열') ? (mom4&&+mom4>0?'상승 추세 + 모멘텀 양호 — 눌림목 매수 검토':'상승 추세이나 모멘텀 약화 — 관망') : maState.includes('역배열') ? '하락 추세 — 추세 전환 신호 확인 필수' : '혼조 — 이평선 돌파 방향 확인 후 진입'}`
    ].filter(Boolean).join('\n\n');
  }

  /* ── 뉴스 ── */
  const NEWS_FEEDS = [
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=SPY&region=US&lang=en-US',
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US',
  ];

  async function fetchNewsItems() {
    let items = [];
    for (const feed of NEWS_FEEDS) {
      try {
        const url = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed)}`;
        const j = await proxyJSON(url, 8000);
        if (j && j.items) items = items.concat(j.items.slice(0, 5));
      } catch (_) {}
    }
    return items.slice(0, 10);
  }

  async function translateToKorean(titles) {
    const key = localStorage.getItem('anthropic_api_key');
    if (!key || !titles.length) return titles.map(t => ({ title: t, ko: t }));
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `아래 영문 뉴스 제목들을 자연스러운 한국어로 번역하고 JSON 배열로 반환하세요.\n입력: ${JSON.stringify(titles)}\n출력형식: [{"title":"원문","ko":"한국어번역"},...]\n다른 텍스트 없이 JSON만 출력.`
          }]
        })
      });
      const d = await r.json();
      const text = d.content?.[0]?.text || '';
      const m = text.match(/\[[\s\S]*\]/);
      if (m) return JSON.parse(m[0]);
    } catch (_) {}
    return titles.map(t => ({ title: t, ko: t }));
  }

  async function renderMajorNews() {
    const items = await fetchNewsItems();
    if (!items.length) return;
    const titles = items.map(i => i.title || '').filter(Boolean);
    const translated = await translateToKorean(titles.slice(0, 6));
    window.__majorNewsItems = translated;
    window.__newsForAnalysis = titles;

    const container = document.getElementById('news-live-note');
    if (!container) return;
    const newsHtml = translated.slice(0, 5).map(n =>
      `<div style="font-size:12px;padding:8px 0;border-bottom:0.5px solid var(--border);line-height:1.5;">${n.ko || n.title}</div>`
    ).join('');
    container.innerHTML = `<div style="margin-top:8px;">${newsHtml}</div><div style="font-size:11px;color:var(--text3);margin-top:6px;">* 최신 뉴스 헤드라인 (자동 번역)</div>`;
  }

  /* ── 뉴스 배지 분류 ── */
  function updateNewsBadgesFromKorean(titles) {
    const text = titles.join(' ').toLowerCase();
    const KR   = (window.__majorNewsItems || []).map(n => (n.ko || '')).join(' ').toLowerCase();
    const all  = text + ' ' + KR;

    function hasTerm(...terms) { return terms.some(t => all.includes(t.toLowerCase())); }

    function setB(id, text, cls) {
      const el = document.getElementById(id);
      if (el) { el.textContent = text; el.className = 'badge ' + cls; }
    }

    // 연준 / 금리
    const hasFedHike  = hasTerm('rate hike','금리인상','긴축','hawkish','매파');
    const hasFedCut   = hasTerm('rate cut','금리인하','pivot','완화','dovish','비둘기');
    const hasFed      = hasTerm('fed','fomc','파월','powell','연준','기준금리');
    if (hasFedCut)        setB('badge-fed', '연준 — 금리인하 기대(호재)', 'badge-g');
    else if (hasFedHike)  setB('badge-fed', '연준 — 금리인상 우려(악재)', 'badge-r');
    else if (hasFed)      setB('badge-fed', '연준 — 관련 소식 있음', 'badge-y');
    else                  setB('badge-fed', '연준 — 주요 소식 없음', 'badge-b');

    // CPI / 물가
    const hasCpiHigh = hasTerm('cpi rises','inflation surge','물가 상승','인플레이션 우려');
    const hasCpiLow  = hasTerm('cpi falls','inflation eases','물가 하락','인플레이션 완화','디스인플레이션');
    const hasCpi     = hasTerm('cpi','pce','inflation','물가','인플레');
    if (hasCpiLow)        setB('badge-cpi', 'CPI — 물가 완화(호재)', 'badge-g');
    else if (hasCpiHigh)  setB('badge-cpi', 'CPI — 물가 상승(악재)', 'badge-r');
    else if (hasCpi)      setB('badge-cpi', 'CPI — 물가 관련 소식', 'badge-y');
    else                  setB('badge-cpi', 'CPI — 주요 소식 없음', 'badge-b');

    // 고용 / NFP
    const hasJobGood = hasTerm('jobs added','employment rises','실업 감소','고용 호조','nfp beat');
    const hasJobBad  = hasTerm('job cuts','layoffs','unemployment rises','실업 증가','고용 부진');
    const hasJob     = hasTerm('nfp','jobs','employment','payrolls','unemployment','고용','실업');
    if (hasJobGood)       setB('badge-nfp', '고용 — 호조(호재)', 'badge-g');
    else if (hasJobBad)   setB('badge-nfp', '고용 — 부진(악재)', 'badge-r');
    else if (hasJob)      setB('badge-nfp', '고용 — 관련 소식', 'badge-y');
    else                  setB('badge-nfp', '고용 — 주요 소식 없음', 'badge-b');

    // 기업 실적
    const hasEarnGood = hasTerm('beats estimates','earnings beat','record earnings','실적 호조','어닝 서프라이즈');
    const hasEarnBad  = hasTerm('misses estimates','earnings miss','profit warning','실적 부진','가이던스 하향');
    const hasEarn     = hasTerm('earnings','eps','revenue','실적','어닝','가이던스');
    if (hasEarnGood)      setB('badge-earnings', '실적 — 호조(호재)', 'badge-g');
    else if (hasEarnBad)  setB('badge-earnings', '실적 — 부진(악재)', 'badge-r');
    else if (hasEarn)     setB('badge-earnings', '실적 — 관련 소식', 'badge-y');
    else                  setB('badge-earnings', '실적 — 주요 소식 없음', 'badge-b');

    // 무역 / 관세
    const hasTradeGood = hasTerm('tariff cut','trade deal','무역 합의','관세 인하','협상 타결');
    const hasTradeBad  = hasTerm('tariff hike','trade war','무역전쟁','관세 인상','제재');
    const hasTrade     = hasTerm('tariff','trade','무역','관세','수출','수입');
    if (hasTradeGood)     setB('badge-trade', '무역 — 긍정적(호재)', 'badge-g');
    else if (hasTradeBad) setB('badge-trade', '무역 — 관세 위협(악재)', 'badge-r');
    else if (hasTrade)    setB('badge-trade', '무역 — 관련 소식', 'badge-y');
    else                  setB('badge-trade', '무역 — 주요 소식 없음', 'badge-b');

    // 지정학
    const hasGeoGood = hasTerm('ceasefire','peace deal','휴전','평화 협상','긴장 완화');
    const hasGeoBad  = hasTerm('war','conflict','attack','전쟁','분쟁','군사','긴장 고조','지정학');
    if (hasGeoGood)       setB('badge-geo', '지정학 — 긴장 완화(호재)', 'badge-g');
    else if (hasGeoBad)   setB('badge-geo', '지정학 — 리스크 있음(악재)', 'badge-r');
    else                  setB('badge-geo', '지정학 — 안정', 'badge-b');

    if (typeof recalcScorecard === 'function') recalcScorecard();
  }

  /* ── 캐시 로드 ── */
  async function loadCachedMarketData() {
    try {
      const r = await fetch('시장데이터.json?_=' + Date.now());
      if (!r.ok) return;
      const d = await r.json();
      if (!d || !d.current) return;
      const pct = d.pct || 0;
      const el = document.getElementById('live-sp500-price');
      if (el) { el.textContent = d.current.toLocaleString(); el.className = 'idx-price ' + (pct >= 0 ? 'up' : 'down'); }
      const ce = document.getElementById('live-sp500-change');
      if (ce) { ce.textContent = `${pct>=0?'▲':' ▼'} ${Math.abs(pct).toFixed(2)}%`; ce.className = 'idx-change ' + (pct >= 0 ? 'up' : 'down'); }
      if (d.score_emoji) {
        const se = document.getElementById('sc-emoji'); if (se) se.textContent = d.score_emoji + ' ' + (d.score_label||'');
        const sp = document.getElementById('sc-pct');   if (sp) sp.textContent = (d.score_pct||50) + '점';
        const sb = document.getElementById('sc-bar');   if (sb) sb.style.width = (d.score_pct||50) + '%';
        const sd = document.getElementById('sc-desc');  if (sd) sd.textContent = d.score_desc || '';
      }
    } catch (_) {}
  }

  /* ── 배지 헬퍼 ── */
  function setBadge(id, text, cls) {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.className = 'badge ' + cls; }
  }

  /* ── 메인 실행 ── */
  async function runRealtime() {
    await loadCachedMarketData();

    let sp500Meta = null;

    // 주봉 1년 데이터 → 기술지표 + AI 분석
    const url1y = `https://query2.finance.yahoo.com/v8/finance/chart/${MAIN_TICKER_URL}?interval=1wk&range=1y`;
    const j1y = await proxyJSON(url1y, 9000);
    if (j1y && j1y.chart && j1y.chart.result && j1y.chart.result[0]) {
      const res1y = j1y.chart.result[0];
      const weekly = (res1y.indicators.quote[0].close || []).filter(p => p != null);
      if (!sp500Meta) sp500Meta = res1y.meta;
      if (weekly.length >= 6) {
        updateTechnicals(sp500Meta, weekly);
        const url5d = `https://query2.finance.yahoo.com/v8/finance/chart/${MAIN_TICKER_URL}?interval=1d&range=5d`;
        const j5d = await proxyJSON(url5d, 6000);
        const d5prices = (j5d && j5d.chart && j5d.chart.result && j5d.chart.result[0])
          ? (j5d.chart.result[0].indicators.quote[0].close || []).filter(p => p != null)
          : null;
        buildAnalysis(MAIN_TICKER_NAME, weekly, d5prices, sp500Meta, 1);
      }
    }

    // 뉴스
    await renderMajorNews();
    const titles = window.__newsForAnalysis || [];
    updateNewsBadgesFromKorean(titles);

    if (typeof recalcScorecard === 'function') recalcScorecard();
    if (typeof ruleBasedAnalysis === 'function' && typeof applyAnalysis === 'function') {
      const liveData = window._liveData || {};
      applyAnalysis(ruleBasedAnalysis(liveData));
    }
  }

  setTimeout(runRealtime, 300);
  setInterval(runRealtime, 5 * 60 * 1000);

})();
