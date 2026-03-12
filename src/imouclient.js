const axios  = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://openapi.easy4ip.com/openapi';
let _token = null, _expiry = 0;

function buildBody(api, params) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce     = crypto.randomBytes(8).toString('hex');
  const sign      = crypto.createHash('md5')
    .update(`time:${timestamp},nonce:${nonce},appSecret:${process.env.IMOU_APP_SECRET}`)
    .digest('hex');
  return {
    system: { ver: '1.0', sign, appId: process.env.IMOU_APP_ID, time: timestamp, nonce },
    params,
    id: String(Math.floor(Math.random() * 10000)),
  };
}

async function callApi(api, params = {}) {
  const res = await axios.post(`${BASE_URL}/${api}`, buildBody(api, params));
  const { result } = res.data;
  if (!result || result.code !== '0') throw new Error(`IMOU API error: ${JSON.stringify(result)}`);
  return result.data || {};
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh && _token && Date.now() / 1000 < _expiry - 60) return _token;
  const data = await callApi('accessToken', {});
  _token  = data.accessToken;
  _expiry = data.expireTime;
  console.log('[IMOU] Token refreshed');
  return _token;
}

async function request(api, params = {}) {
  // First attempt with cached token
  try {
    return await callApi(api, { ...params, token: await getToken() });
  } catch (err) {
    // OP1009 = token invalidated server-side (e.g. after camera reboot)
    // Force a fresh token and retry once
    if (err.message.includes('OP1009')) {
      console.log('[IMOU] OP1009 — forcing token refresh and retrying');
      _token = null; _expiry = 0;
      return await callApi(api, { ...params, token: await getToken(true) });
    }
    throw err;
  }
}

module.exports = { request };