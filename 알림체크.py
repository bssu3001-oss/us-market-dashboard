import os, json, datetime, urllib.request, urllib.parse, time

KAKAO_REST_API_KEY  = os.environ.get('KAKAO_REST_API_KEY', '')
KAKAO_REFRESH_TOKEN = os.environ.get('KAKAO_REFRESH_TOKEN', '')
KAKAO_CLIENT_SECRET = os.environ.get('KAKAO_CLIENT_SECRET', '')
ANTHROPIC_API_KEY   = os.environ.get('ANTHROPIC_API_KEY', '')

DASHBOARD_URL = 'https://bssu3001-oss.github.io/us-market-dashboard/'
STATE_FILE    = '알림상태.json'
MARKET_FILE   = '시장데이터.json'

KST = datetime.timezone(datetime.timedelta(hours=9))

def now_kst():
    return datetime.datetime.now(KST)

def today_str():
    return now_kst().strftime('%Y-%m-%d')

def slot_name():
    h = now_kst().hour
    if h < 11:  return 'morning'
    if h < 16:  return 'afternoon'
    return 'evening'

def slot_label():
    s = slot_name()
    return {'morning':'오전','afternoon':'오후','evening':'저녁'}[s]

# ── 상태 ──
def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_state(state):
    today = today_str()
    cutoff = (now_kst() - datetime.timedelta(days=3)).strftime('%Y-%m-%d')
    pruned = {k: v for k, v in state.items() if k >= cutoff}
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        json.dump(pruned, f, ensure_ascii=False, indent=2)

def is_sent(state, key):
    return key in state.get(today_str(), [])

def mark_sent(state, key):
    d = today_str()
    if d not in state:
        state[d] = []
    if key not in state[d]:
        state[d].append(key)

# ── 카카오 토큰 ──
def kakao_get_access_token():
    data = urllib.parse.urlencode({
        'grant_type':    'refresh_token',
        'client_id':     KAKAO_REST_API_KEY,
        'refresh_token': KAKAO_REFRESH_TOKEN,
        'client_secret': KAKAO_CLIENT_SECRET,
    }).encode()
    req = urllib.request.Request('https://kauth.kakao.com/oauth/token', data=data, method='POST')
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())['access_token']

def kakao_send(access_token, text):
    msg = json.dumps({'object_type':'text','text':text,'link':{'web_url':DASHBOARD_URL,'mobile_web_url':DASHBOARD_URL}}, ensure_ascii=False)
    data = urllib.parse.urlencode({'template_object': msg}).encode()
    req = urllib.request.Request(
        'https://kapi.kakao.com/v2/api/talk/memo/default/send',
        data=data,
        headers={'Authorization': f'Bearer {access_token}'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        result = json.loads(r.read())
    if result.get('result_code') == 0:
        print('✅ 카카오 전송 완료')
    else:
        print(f'⚠️ 카카오 전송 실패: {result}')

# ── 시장 데이터 ──
def fetch_market_data():
    try:
        import yfinance as yf
    except ImportError:
        os.system('pip install yfinance -q')
        import yfinance as yf

    # S&P 500 주봉 1년
    sp = yf.download('^GSPC', period='1y', interval='1wk', progress=False)
    if sp.empty:
        raise RuntimeError('S&P 500 데이터 없음')
    close_col = sp['Close']
    if hasattr(close_col, 'ndim') and close_col.ndim > 1:
        close_col = close_col.iloc[:, 0]
    closes = [float(v) for v in close_col.dropna().values.tolist()]
    n = len(closes)
    cur = closes[-1]

    # 이평선
    ma5  = sum(closes[-5:]) /5   if n>=5  else None
    ma13 = sum(closes[-13:])/13  if n>=13 else None
    ma26 = sum(closes[-26:])/26  if n>=26 else None

    ma_state = '혼조'
    ma_signal = 'neutral'
    if ma5 and ma13 and ma26:
        if cur>ma5 and ma5>ma13 and ma13>ma26:   ma_state='정배열'; ma_signal='bull'
        elif cur<ma5 and ma5<ma13 and ma13<ma26: ma_state='역배열'; ma_signal='bear'
    elif ma5 and ma13:
        if cur>ma5 and ma5>ma13: ma_state='단기 정배열'; ma_signal='bull'
        elif cur<ma5 and ma5<ma13: ma_state='단기 역배열'; ma_signal='bear'

    # RSI 14주
    gains, losses = 0.0, 0.0
    periods = min(14, n-1)
    for i in range(n-periods, n):
        d = closes[i] - closes[i-1]
        if d > 0: gains += d
        else:     losses += abs(d)
    avg_g = gains/periods; avg_l = losses/periods
    rsi = 100 if avg_l==0 else 100 - 100/(1 + avg_g/avg_l)

    # 4주 모멘텀
    mom4 = (closes[-1]-closes[-5])/closes[-5]*100 if n>=5 else 0

    # 52주 위치
    hi52 = max(closes[-52:]) if n>=52 else max(closes)
    from_hi = (cur - hi52)/hi52*100

    # 추가 지표
    extras = yf.download(['^VIX','DX-Y.NYB','^TNX','BZ=F','GC=F','KRW=X','^IXIC'],
                          period='5d', interval='1d', progress=False)
    def last_close(ticker):
        try:
            col = ('Close', ticker) if ('Close', ticker) in extras.columns else None
            if col is None: return None
            vals = extras[col].dropna()
            return float(vals.iloc[-1]) if len(vals) else None
        except Exception:
            return None

    vix      = last_close('^VIX')
    dxy      = last_close('DX-Y.NYB')
    tnx      = last_close('^TNX')
    crude    = last_close('BZ=F')
    gold     = last_close('GC=F')
    usdkrw   = last_close('KRW=X')
    nasdaq   = last_close('^IXIC')

    # 전일 대비 등락
    try:
        sp1d = yf.download('^GSPC', period='5d', interval='1d', progress=False)['Close'].dropna()
        pct = float((sp1d.iloc[-1]-sp1d.iloc[-2])/sp1d.iloc[-2]*100) if len(sp1d)>=2 else 0
        nasdaq1d = yf.download('^IXIC', period='5d', interval='1d', progress=False)['Close'].dropna()
        nasdaq_pct = float((nasdaq1d.iloc[-1]-nasdaq1d.iloc[-2])/nasdaq1d.iloc[-2]*100) if len(nasdaq1d)>=2 else 0
    except Exception:
        pct = 0; nasdaq_pct = 0

    return {
        'current':    round(cur, 2),
        'pct':        round(pct, 2),
        'ma_signal':  ma_signal,
        'ma_state':   ma_state,
        'rsi':        round(rsi, 1),
        'mom4':       round(mom4, 2),
        'from_hi':    round(from_hi, 1),
        'vix':        round(vix, 1) if vix else None,
        'dxy':        round(dxy, 2) if dxy else None,
        'tnx':        round(tnx, 2) if tnx else None,
        'crude':      round(crude, 1) if crude else None,
        'gold':       round(gold, 0) if gold else None,
        'usdkrw':     round(usdkrw, 0) if usdkrw else None,
        'nasdaq':     round(nasdaq, 2) if nasdaq else None,
        'nasdaq_pct': round(nasdaq_pct, 2),
    }

# ── 종합 점수 ──
def calc_scorecard(data, news_titles):
    tech_score = 0.0
    rsi = data['rsi']
    if rsi <= 40:   tech_score += 1.5
    elif rsi >= 70: tech_score -= 1.5
    ma = data['ma_signal']
    if ma == 'bull':    tech_score += 1.5
    elif ma == 'bear':  tech_score -= 1.5
    mom = data['mom4']
    if mom >= 2:    tech_score += 1.5
    elif mom <= -2: tech_score -= 1.5
    fhi = data['from_hi']
    if fhi <= -20:  tech_score += 1.5

    macro_score = 0.0
    vix = data.get('vix')
    if vix:
        if vix < 18:   macro_score += 1.0
        elif vix > 28: macro_score -= 1.0
    dxy = data.get('dxy')
    if dxy:
        if dxy < 100:   macro_score += 1.0
        elif dxy > 106: macro_score -= 1.0
    crude = data.get('crude')
    if crude:
        if crude < 75:  macro_score += 1.0
        elif crude > 90: macro_score -= 1.0
    tnx = data.get('tnx')
    if tnx:
        if tnx < 4.0:   macro_score += 1.0
        elif tnx > 4.8: macro_score -= 1.0

    news_score = 0.0
    text = ' '.join(news_titles).lower()
    if any(t in text for t in ['rate cut','금리인하','pivot','dovish']):      news_score += 0.8
    elif any(t in text for t in ['rate hike','금리인상','hawkish','taper']): news_score -= 0.8
    if any(t in text for t in ['cpi falls','inflation eases','물가 완화']):   news_score += 0.8
    elif any(t in text for t in ['cpi rises','inflation surge','물가 상승']): news_score -= 0.8
    if any(t in text for t in ['earnings beat','실적 호조','beat estimates']): news_score += 0.8
    elif any(t in text for t in ['earnings miss','실적 부진','profit warning']): news_score -= 0.8

    total = tech_score + macro_score + news_score
    max_s = 4*1.5 + 4*1.0 + 3*0.8
    pct = max(0, min(100, round((total + max_s) / (2*max_s) * 100)))

    if total >= max_s * 0.5:    label='강매수';   emoji='🔥'
    elif total >= max_s * 0.15: label='매수 검토'; emoji='🟢'
    elif total >= -max_s*0.15:  label='관망';     emoji='📌'
    elif total >= -max_s*0.5:   label='조심';     emoji='⚠️'
    else:                        label='진입 자제'; emoji='🔴'

    desc_parts = [f'이평선 {data["ma_state"]} (RSI {rsi:.0f})']
    if vix:   desc_parts.append(f'VIX {vix:.1f}')
    if tnx:   desc_parts.append(f'10Y금리 {tnx:.2f}%')
    if dxy:   desc_parts.append(f'DXY {dxy:.1f}')
    desc = ' / '.join(desc_parts)

    return pct, label, emoji, desc

# ── 조건 알림 ──
def check_conditions(data):
    alerts = []
    rsi   = data['rsi']
    ma    = data['ma_signal']
    mom   = data['mom4']
    fhi   = data['from_hi']
    cur   = data['current']
    vix   = data.get('vix') or 0
    pct   = data['pct']

    if rsi <= 35:
        alerts.append(('매수핵심', f'🎯 RSI {rsi:.0f} — 과매도 진입! 분할매수 1차 시작 고려'))
    if ma == 'bull' and mom > 0:
        alerts.append(('매수핵심', f'📈 이평 정배열 + 모멘텀 양호 — 추세 매수 구간'))
    if fhi <= -15 and rsi <= 45:
        alerts.append(('매수참고', f'📉 고점 대비 {fhi:.1f}% + RSI {rsi:.0f} — 저점 매수 구간 검토'))
    if ma == 'bull' and pct >= 1.5:
        alerts.append(('호재', f'🌟 상승 추세 + 당일 {pct:.1f}% — 강한 모멘텀 확인'))
    if vix >= 28:
        alerts.append(('주의', f'⚠️ VIX {vix:.1f} — 공포 구간 진입! 변동성 확대 주의'))
    if cur <= 4500:
        alerts.append(('손절경고', f'🔴 S&P 500 {cur:,.0f} — 손절 기준선 접근! 리스크 관리 필요'))

    return alerts

# ── 뉴스 ──
def fetch_news_headlines():
    import xml.etree.ElementTree as ET
    feeds = [
        'https://news.google.com/rss/search?q=S%26P+500+stock+market&hl=ko&gl=KR&ceid=KR:ko',
        'https://news.google.com/rss/search?q=US+stock+market+Fed&hl=ko&gl=KR&ceid=KR:ko',
    ]
    titles = []
    for url in feeds:
        try:
            req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=8) as r:
                tree = ET.fromstring(r.read())
            for item in tree.findall('.//item')[:3]:
                t = item.findtext('title', '').strip()
                if t: titles.append(t)
        except Exception:
            pass
    return titles[:6]

# ── 메시지 빌드 ──
def gen_ai_fields(data, news_titles):
    """Claude API로 핵심 매력/리스크/진입단서 생성 (없으면 규칙 기반 폴백)"""
    ma = data.get('ma_state', '')
    rsi = data.get('rsi', 50)
    vix = data.get('vix') or 0
    from_hi = data.get('from_hi', 0)
    mom4 = data.get('mom4', 0)

    default_appeal = '이평선 정배열' if '정배열' in ma else ('RSI 과매도' if rsi <= 40 else 'AI/빅테크 실적')
    default_risk = '금리 인하 지연' if vix > 20 else ('역배열 지속' if '역배열' in ma else 'VIX 상승 주의')
    default_entry = '이평선 정배열 전환 후' if '역배열' in ma else 'VIX 안정 시 분할 매수'
    default_danger = '높음' if vix > 28 else ('보통' if vix > 18 else '낮음')

    if not ANTHROPIC_API_KEY:
        return default_appeal, default_risk, default_entry, default_danger

    try:
        import urllib.request, json
        news_str = ' / '.join(news_titles[:3]) if news_titles else '없음'
        prompt = (
            f"미국 S&P 500 현황:\n"
            f"- S&P 500: {data['current']:,.0f} ({data['pct']:+.2f}%)\n"
            f"- 이평선: {ma} | RSI: {rsi:.0f} | 4주 모멘텀: {mom4:+.1f}%\n"
            f"- VIX: {vix} | 고점대비: {from_hi:.1f}%\n"
            f"- 주요 뉴스: {news_str}\n\n"
            f"아래 JSON으로만 답해:\n"
            f'{{ "appeal": "핵심 매력 10자 이내", "risk": "핵심 리스크 10자 이내", "entry": "진입 단서 15자 이내", "danger": "낮음/보통/높음 중 하나" }}'
        )
        body = json.dumps({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 200,
            "messages": [{"role": "user", "content": prompt}]
        }).encode()
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            res = json.loads(r.read())
        text = res["content"][0]["text"].strip()
        start = text.find("{"); end = text.rfind("}") + 1
        ag = json.loads(text[start:end])
        return ag.get("appeal", default_appeal), ag.get("risk", default_risk), ag.get("entry", default_entry), ag.get("danger", default_danger)
    except Exception as e:
        print(f"  AI 필드 생성 실패: {e}")
        return default_appeal, default_risk, default_entry, default_danger


def build_message(data, score_pct, score_label, score_emoji, score_desc, news_titles):
    now = now_kst()
    ts = now.strftime('%Y-%m-%d %H:%M')
    slot = slot_label()

    p   = data['current']
    pct = data['pct']
    vix = data.get('vix')
    tnx = data.get('tnx')
    dxy = data.get('dxy')
    arrow = '▲' if pct >= 0 else '▼'

    appeal, risk, entry, danger = gen_ai_fields(data, news_titles)

    vix_status = f"{vix:.1f} {'안정' if vix < 18 else '주의' if vix < 28 else '공포'}" if vix else 'N/A'
    macro_parts = []
    if tnx: macro_parts.append(f'10년물 {tnx:.2f}%')
    if dxy: macro_parts.append(f'DXY {dxy:.1f}')
    macro_line = ' | '.join(macro_parts)

    news_line = ''
    if news_titles:
        news_line = f'\n📰 {news_titles[0][:50]}'

    return (
        f'🇺🇸 미국 증시 {slot} [{ts}]\n'
        f'━━━━━━━━━━━━\n'
        f'S&P 500  {p:,.0f} {arrow}{abs(pct):.2f}%\n'
        f'\n'
        f'{score_emoji} {score_label}  {score_pct}점 / 100점\n'
        f'\n'
        f'📈 핵심 매력  {appeal}\n'
        f'⚠️ 핵심 리스크  {risk}\n'
        f'🎯 진입 단서  {entry}\n'
        f'🔰 위험도  {danger}\n'
        f'\n'
        f'── 주요 지표 ──\n'
        f'이평선 {data["ma_state"]} | RSI {data["rsi"]:.0f}\n'
        f'VIX {vix_status} | {macro_line}'
        f'{news_line}'
    )


def main():
    print(f'[{now_kst().strftime("%Y-%m-%d %H:%M:%S")} KST] 미국증시 알림체크 시작')
    state = load_state()

    if not KAKAO_REST_API_KEY or not KAKAO_REFRESH_TOKEN:
        print('⚠️ 카카오 환경변수 없음 — 알림 생략')
        return

    access_token = kakao_get_access_token()
    print(f'✅ 카카오 토큰 갱신 완료')

    data = fetch_market_data()
    print(f'✅ 시장 데이터: S&P 500 {data["current"]:,.2f} ({data["pct"]:+.2f}%)')

    news = fetch_news_headlines()
    print(f'✅ 뉴스 {len(news)}건')

    pct, label, emoji, desc = calc_scorecard(data, news)
    print(f'✅ 종합신호: {emoji} {label} ({pct}점)')

    # 시황 알림
    slot = slot_name()
    slot_key = f'ai_comment_{slot}'
    if not is_sent(state, slot_key):
        msg = build_message(data, pct, label, emoji, desc, news)
        kakao_send(access_token, msg)
        mark_sent(state, slot_key)
        time.sleep(1)

    # 조건 알림
    conditions = check_conditions(data)
    for kind, msg_body in conditions:
        cond_key = f'{kind}_{slot}'
        if not is_sent(state, cond_key):
            full_msg = f'{msg_body}\n\n🔗 {DASHBOARD_URL}'
            kakao_send(access_token, full_msg)
            mark_sent(state, cond_key)
            time.sleep(1)

    save_state(state)
    print('✅ 상태 저장 완료')

    # 시장데이터.json 저장
    market_out = {
        **data,
        'score_pct':   pct,
        'score_label': label,
        'score_emoji': emoji,
        'score_desc':  desc,
        'updated_at':  now_kst().strftime('%Y-%m-%d %H:%M KST'),
    }
    with open(MARKET_FILE, 'w', encoding='utf-8') as f:
        json.dump(market_out, f, ensure_ascii=False, indent=2)
    print('✅ 시장데이터.json 저장 완료')

if __name__ == '__main__':
    main()
