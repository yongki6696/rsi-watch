'use strict';
const naver = require('./naver');
const coupang = require('./coupang');
const elevenst = require('./elevenst');
const { gmarket, auction } = require('./esm');
const lotteon = require('./lotteon');
const demo = require('./demo');

const CONNECTORS = { naver, coupang, elevenst, gmarket, auction, lotteon, demo };

function getConnector(type) {
  const c = CONNECTORS[type];
  if (!c) throw new Error(`지원하지 않는 마켓: ${type}`);
  return c;
}

function listConnectors() {
  return Object.values(CONNECTORS).map((c) => ({
    type: c.type,
    label: c.label,
    short: c.short,
    color: c.color,
    beta: !!c.beta,
    inquiries: !!c.inquiries,
    answerable: !!c.answerable,
    sellerCenter: c.sellerCenter || '',
    fields: c.fields,
    guide: c.guide,
  }));
}

module.exports = { getConnector, listConnectors, CONNECTORS };
