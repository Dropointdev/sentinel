const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://openapi.easy4ip.com/openapi';

let _accessToken = null;
let _tokenExpiry = 0;

function buildRequestBody(api, params) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const sign = crypto
    .createHash('md5')
    .update(`time:${timestamp},nonce:${nonce},appSecret:${process.env.IMOU_APP_SECRET}`)
    .digest('hex');

  return {
    system: {
      ver: '1.0',
      sign,
      appId: process.env.IMOU_APP_ID,
      time: timestamp,
      nonce,
    },
    params,
    id: String(Math.floor(Math.random() * 10000)),
  };
}

async function callApi(api, params = {}) {
  const body = buildRequestBody(api, params);
  const url = `${BASE_URL}/${api}`;

  const response = await axios.post(url, body);
  const { result } = response.data;

  if (!result || result.code !== '0') {
    throw new Error(`IMOU API error: ${JSON.stringify(result)}`);
  }

  return result.data || {};
}

async function getToken() {
  // Return cached token if still valid (with 60s buffer)
  if (_accessToken && Date.now() / 1000 < _tokenExpiry - 60) {
    return _accessToken;
  }

  const data = await callApi('accessToken', {});
  _accessToken = data.accessToken;
  _tokenExpiry = data.expireTime;
  console.log('[IMOU] Access token refreshed');
  return _accessToken;
}

async function request(api, params = {}) {
  const token = await getToken();
  return callApi(api, { ...params, token });
}

module.exports = { request, getToken };