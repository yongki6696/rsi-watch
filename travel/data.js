/*
 * 어디가지 — 정적 참조 데이터 (출발지, 도시, 항공사, 국가)
 * 페이지 · 서비스워커 · Node 테스트에서 함께 사용합니다.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.TravelData = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REGIONS = {
    ne: '동북아',
    se: '동남아',
    oc: '대양주·괌',
    am: '미주',
    eu: '유럽',
    etc: '중동·중앙아'
  };

  // 국가코드: [국가명, 권역]
  var COUNTRIES = {
    JP: ['일본', 'ne'], CN: ['중국', 'ne'], TW: ['대만', 'ne'], HK: ['홍콩', 'ne'],
    MO: ['마카오', 'ne'], MN: ['몽골', 'ne'], RU: ['러시아', 'ne'],
    VN: ['베트남', 'se'], TH: ['태국', 'se'], PH: ['필리핀', 'se'], SG: ['싱가포르', 'se'],
    MY: ['말레이시아', 'se'], ID: ['인도네시아', 'se'], KH: ['캄보디아', 'se'], LA: ['라오스', 'se'],
    GU: ['괌', 'oc'], MP: ['사이판', 'oc'], PW: ['팔라우', 'oc'], AU: ['호주', 'oc'],
    NZ: ['뉴질랜드', 'oc'], FJ: ['피지', 'oc'],
    US: ['미국', 'am'], CA: ['캐나다', 'am'], MX: ['멕시코', 'am'],
    FR: ['프랑스', 'eu'], GB: ['영국', 'eu'], DE: ['독일', 'eu'], IT: ['이탈리아', 'eu'],
    ES: ['스페인', 'eu'], CZ: ['체코', 'eu'], CH: ['스위스', 'eu'], NL: ['네덜란드', 'eu'],
    AT: ['오스트리아', 'eu'], HU: ['헝가리', 'eu'], PT: ['포르투갈', 'eu'], TR: ['튀르키예', 'eu'],
    FI: ['핀란드', 'eu'], PL: ['폴란드', 'eu'], HR: ['크로아티아', 'eu'], GR: ['그리스', 'eu'],
    AE: ['아랍에미리트', 'etc'], QA: ['카타르', 'etc'], UZ: ['우즈베키스탄', 'etc'],
    KZ: ['카자흐스탄', 'etc'], IN: ['인도', 'etc'], NP: ['네팔', 'etc'], MV: ['몰디브', 'etc'],
    LK: ['스리랑카', 'etc'], EG: ['이집트', 'etc']
  };

  // 항공사: [이름, 유형]  kfsc=국적 대형사, fsc=외항 대형사, lcc=저비용, hsc=하이브리드
  var AIRLINES = {
    KE: ['대한항공', 'kfsc'], OZ: ['아시아나항공', 'kfsc'],
    '7C': ['제주항공', 'lcc'], LJ: ['진에어', 'lcc'], TW: ['티웨이항공', 'lcc'],
    BX: ['에어부산', 'lcc'], RS: ['에어서울', 'lcc'], ZE: ['이스타항공', 'lcc'],
    RF: ['에어로케이', 'lcc'], YP: ['에어프레미아', 'hsc'],
    JL: ['일본항공', 'fsc'], NH: ['전일본공수', 'fsc'], MM: ['피치항공', 'lcc'], ZG: ['집에어', 'lcc'],
    MU: ['중국동방항공', 'fsc'], FM: ['상하이항공', 'fsc'], CA: ['중국국제항공', 'fsc'], SC: ['산둥항공', 'fsc'],
    CI: ['중화항공', 'fsc'], BR: ['에바항공', 'fsc'], IT: ['타이거에어 타이완', 'lcc'],
    CX: ['캐세이퍼시픽', 'fsc'], UO: ['홍콩익스프레스', 'lcc'], NX: ['에어마카오', 'fsc'],
    VN: ['베트남항공', 'fsc'], VJ: ['비엣젯항공', 'lcc'], TG: ['타이항공', 'fsc'], XJ: ['타이에어아시아엑스', 'lcc'],
    PR: ['필리핀항공', 'fsc'], '5J': ['세부퍼시픽', 'lcc'], SQ: ['싱가포르항공', 'fsc'], TR: ['스쿠트', 'lcc'],
    MH: ['말레이시아항공', 'fsc'], D7: ['에어아시아엑스', 'lcc'], GA: ['가루다인도네시아', 'fsc'],
    OM: ['몽골항공', 'fsc'], HA: ['하와이안항공', 'fsc'], DL: ['델타항공', 'fsc'], UA: ['유나이티드항공', 'fsc'],
    AA: ['아메리칸항공', 'fsc'], AC: ['에어캐나다', 'fsc'], QF: ['콴타스항공', 'fsc'], JQ: ['젯스타', 'lcc'],
    NZ: ['에어뉴질랜드', 'fsc'], AF: ['에어프랑스', 'fsc'], BA: ['영국항공', 'fsc'], LH: ['루프트한자', 'fsc'],
    KL: ['KLM', 'fsc'], AY: ['핀에어', 'fsc'], LO: ['폴란드항공', 'fsc'], TK: ['튀르키예항공', 'fsc'],
    EK: ['에미레이트항공', 'fsc'], QR: ['카타르항공', 'fsc'], EY: ['에티하드항공', 'fsc'],
    HY: ['우즈베키스탄항공', 'fsc'], KC: ['에어아스타나', 'fsc'], AI: ['에어인디아', 'fsc']
  };

  // [도시코드, 대표공항, 이름, 국가, 시간대, 서울발 비행시간(분), 평소 왕복가(원), 운항 항공사]
  var CITY_ROWS = [
    ['TYO', 'NRT', '도쿄', 'JP', 'Asia/Tokyo', 140, 290000, ['KE', 'OZ', '7C', 'LJ', 'ZE', 'JL', 'NH', 'ZG']],
    ['OSA', 'KIX', '오사카', 'JP', 'Asia/Tokyo', 110, 250000, ['KE', 'OZ', '7C', 'LJ', 'TW', 'BX', 'MM']],
    ['FUK', 'FUK', '후쿠오카', 'JP', 'Asia/Tokyo', 85, 199000, ['KE', 'OZ', '7C', 'LJ', 'TW', 'BX', 'RS']],
    ['SPK', 'CTS', '삿포로', 'JP', 'Asia/Tokyo', 170, 349000, ['KE', 'OZ', '7C', 'LJ', 'TW']],
    ['OKA', 'OKA', '오키나와', 'JP', 'Asia/Tokyo', 135, 279000, ['KE', 'OZ', '7C', 'LJ', 'TW']],
    ['NGO', 'NGO', '나고야', 'JP', 'Asia/Tokyo', 110, 259000, ['KE', '7C', 'LJ']],
    ['SHA', 'PVG', '상하이', 'CN', 'Asia/Shanghai', 115, 269000, ['KE', 'OZ', 'MU', 'FM', '7C']],
    ['BJS', 'PEK', '베이징', 'CN', 'Asia/Shanghai', 130, 299000, ['KE', 'OZ', 'CA']],
    ['TAO', 'TAO', '칭다오', 'CN', 'Asia/Shanghai', 85, 209000, ['KE', 'OZ', 'SC', '7C']],
    ['TPE', 'TPE', '타이베이', 'TW', 'Asia/Taipei', 150, 299000, ['KE', 'OZ', 'CI', 'BR', 'IT', '7C', 'TW', 'LJ']],
    ['KHH', 'KHH', '가오슝', 'TW', 'Asia/Taipei', 180, 329000, ['7C', 'TW', 'CI']],
    ['HKG', 'HKG', '홍콩', 'HK', 'Asia/Hong_Kong', 220, 349000, ['KE', 'OZ', 'CX', 'UO', '7C', 'LJ']],
    ['MFM', 'MFM', '마카오', 'MO', 'Asia/Macau', 220, 329000, ['NX', 'LJ', '7C', 'TW']],
    ['ULN', 'UBN', '울란바토르', 'MN', 'Asia/Ulaanbaatar', 210, 459000, ['KE', 'OM', '7C']],
    ['SGN', 'SGN', '호치민', 'VN', 'Asia/Ho_Chi_Minh', 330, 429000, ['KE', 'OZ', 'VN', 'VJ', '7C']],
    ['HAN', 'HAN', '하노이', 'VN', 'Asia/Ho_Chi_Minh', 280, 389000, ['KE', 'OZ', 'VN', 'VJ', '7C', 'LJ']],
    ['DAD', 'DAD', '다낭', 'VN', 'Asia/Ho_Chi_Minh', 280, 359000, ['KE', 'OZ', 'VN', 'VJ', '7C', 'TW', 'LJ', 'BX']],
    ['PQC', 'PQC', '푸꾸옥', 'VN', 'Asia/Ho_Chi_Minh', 340, 429000, ['VJ', 'VN', '7C']],
    ['NHA', 'CXR', '나트랑', 'VN', 'Asia/Ho_Chi_Minh', 310, 409000, ['VJ', '7C', 'LJ', 'BX']],
    ['BKK', 'BKK', '방콕', 'TH', 'Asia/Bangkok', 360, 409000, ['KE', 'OZ', 'TG', '7C', 'ZE', 'LJ', 'XJ']],
    ['HKT', 'HKT', '푸껫', 'TH', 'Asia/Bangkok', 380, 529000, ['KE', '7C', 'ZE']],
    ['CNX', 'CNX', '치앙마이', 'TH', 'Asia/Bangkok', 360, 489000, ['7C', 'LJ', 'ZE']],
    ['MNL', 'MNL', '마닐라', 'PH', 'Asia/Manila', 240, 339000, ['KE', 'OZ', 'PR', '5J', '7C', 'LJ']],
    ['CEB', 'CEB', '세부', 'PH', 'Asia/Manila', 270, 349000, ['KE', 'PR', '5J', '7C', 'LJ', 'BX']],
    ['SIN', 'SIN', '싱가포르', 'SG', 'Asia/Singapore', 380, 529000, ['KE', 'OZ', 'SQ', 'TR']],
    ['KUL', 'KUL', '쿠알라룸푸르', 'MY', 'Asia/Kuala_Lumpur', 400, 459000, ['KE', 'MH', 'D7']],
    ['BKI', 'BKI', '코타키나발루', 'MY', 'Asia/Kuching', 300, 439000, ['KE', '7C', 'ZE', 'D7']],
    ['DPS', 'DPS', '발리', 'ID', 'Asia/Makassar', 420, 619000, ['KE', 'GA', '7C']],
    ['GUM', 'GUM', '괌', 'GU', 'Pacific/Guam', 260, 429000, ['KE', '7C', 'LJ', 'TW']],
    ['SPN', 'SPN', '사이판', 'MP', 'Pacific/Saipan', 255, 419000, ['OZ', '7C', 'LJ', 'TW']],
    ['HNL', 'HNL', '호놀룰루', 'US', 'Pacific/Honolulu', 480, 919000, ['KE', 'OZ', 'HA']],
    ['LAX', 'LAX', '로스앤젤레스', 'US', 'America/Los_Angeles', 660, 1219000, ['KE', 'OZ', 'DL']],
    ['SFO', 'SFO', '샌프란시스코', 'US', 'America/Los_Angeles', 630, 1259000, ['KE', 'OZ', 'UA', 'YP']],
    ['NYC', 'JFK', '뉴욕', 'US', 'America/New_York', 840, 1459000, ['KE', 'OZ', 'DL', 'YP']],
    ['SEA', 'SEA', '시애틀', 'US', 'America/Los_Angeles', 600, 1159000, ['KE', 'DL', 'OZ']],
    ['YVR', 'YVR', '밴쿠버', 'CA', 'America/Vancouver', 570, 1159000, ['KE', 'AC']],
    ['SYD', 'SYD', '시드니', 'AU', 'Australia/Sydney', 615, 1059000, ['KE', 'OZ', 'QF', 'TW']],
    ['BNE', 'BNE', '브리즈번', 'AU', 'Australia/Brisbane', 580, 1009000, ['KE', 'TW', 'JQ']],
    ['AKL', 'AKL', '오클랜드', 'NZ', 'Pacific/Auckland', 680, 1209000, ['KE', 'NZ']],
    ['PAR', 'CDG', '파리', 'FR', 'Europe/Paris', 840, 1359000, ['KE', 'AF', 'OZ']],
    ['LON', 'LHR', '런던', 'GB', 'Europe/London', 850, 1409000, ['KE', 'OZ', 'BA']],
    ['FRA', 'FRA', '프랑크푸르트', 'DE', 'Europe/Berlin', 820, 1309000, ['KE', 'LH', 'OZ']],
    ['ROM', 'FCO', '로마', 'IT', 'Europe/Rome', 810, 1309000, ['KE', 'OZ', 'TW']],
    ['BCN', 'BCN', '바르셀로나', 'ES', 'Europe/Madrid', 860, 1359000, ['OZ', 'TW']],
    ['PRG', 'PRG', '프라하', 'CZ', 'Europe/Prague', 800, 1289000, ['KE']],
    ['IST', 'IST', '이스탄불', 'TR', 'Europe/Istanbul', 720, 1109000, ['TK', 'OZ', 'KE']],
    ['DXB', 'DXB', '두바이', 'AE', 'Asia/Dubai', 600, 1009000, ['EK', 'KE']],
    ['TAS', 'TAS', '타슈켄트', 'UZ', 'Asia/Tashkent', 450, 759000, ['HY', 'OZ']],
    ['ALA', 'ALA', '알마티', 'KZ', 'Asia/Almaty', 420, 709000, ['KC', 'OZ']],
    ['DEL', 'DEL', '델리', 'IN', 'Asia/Kolkata', 510, 909000, ['AI', 'KE']]
  ];

  // 장거리 경유편을 운항하는 외항사 (데모 데이터용)
  var CONNECTING = {
    am: ['JL', 'NH', 'CI', 'BR'],
    oc: ['CX', 'SQ', 'CI'],
    eu: ['CX', 'TK', 'EK', 'QR', 'AY', 'LO', 'MU'],
    etc: ['CX', 'EK', 'SQ'],
    se: ['CX', 'CI'],
    ne: ['CX']
  };

  // 출발지: code=검색에 쓰는 도시/공항 코드, airport=대표 공항
  var ORIGINS = [
    { code: 'SEL', airport: 'ICN', name: '서울 (인천·김포)', factor: 1.0, longHaul: true },
    { code: 'PUS', airport: 'PUS', name: '부산 (김해)', factor: 1.06, longHaul: false },
    { code: 'CJU', airport: 'CJU', name: '제주', factor: 1.14, longHaul: false },
    { code: 'TAE', airport: 'TAE', name: '대구', factor: 1.1, longHaul: false },
    { code: 'CJJ', airport: 'CJJ', name: '청주', factor: 1.1, longHaul: false }
  ];

  var CITIES = CITY_ROWS.map(function (r) {
    return {
      code: r[0], airport: r[1], name: r[2], country: r[3], tz: r[4],
      minutes: r[5], basePrice: r[6], airlines: r[7]
    };
  });

  // 도시코드와 공항코드 모두로 찾을 수 있게 색인
  var CITY_INDEX = {};
  CITIES.forEach(function (c) {
    CITY_INDEX[c.code] = c;
    if (!CITY_INDEX[c.airport]) CITY_INDEX[c.airport] = c;
  });
  // 같은 도시의 다른 공항
  [['HND', 'TYO'], ['ITM', 'OSA'], ['PKX', 'BJS'], ['DMK', 'BKK'], ['EWR', 'NYC'], ['LGA', 'NYC'],
   ['ORY', 'PAR'], ['LGW', 'LON'], ['CIA', 'ROM'], ['SAW', 'IST'], ['TSA', 'TPE']].forEach(function (p) {
    if (!CITY_INDEX[p[0]]) CITY_INDEX[p[0]] = CITY_INDEX[p[1]];
  });

  return {
    REGIONS: REGIONS,
    COUNTRIES: COUNTRIES,
    AIRLINES: AIRLINES,
    CITIES: CITIES,
    CITY_INDEX: CITY_INDEX,
    CONNECTING: CONNECTING,
    ORIGINS: ORIGINS,
    HOME_TZ: 'Asia/Seoul'
  };
});
