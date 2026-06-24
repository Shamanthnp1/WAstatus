#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const axios = require('axios');

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v25.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const requiredEnv = ['WHATSAPP_TOKEN', 'WHATSAPP_BUSINESS_ID'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`Missing required env var(s): ${missingEnv.join(', ')}`);
  process.exit(1);
}

const token = process.env.WHATSAPP_TOKEN;
const wabaId = process.env.WHATSAPP_BUSINESS_ID;
const phoneId = process.env.WHATSAPP_PHONE_ID;

const authConfig = {
  headers: {
    Authorization: `Bearer ${token}`,
  },
};

function getGraphError(error) {
  const graphError = error.response?.data?.error;

  return {
    status: error.response?.status,
    message: graphError?.message || error.message,
    type: graphError?.type,
    code: graphError?.code,
    subcode: graphError?.error_subcode,
    traceId: graphError?.fbtrace_id,
  };
}

function printGraphError(label, error) {
  const details = getGraphError(error);

  console.error(`\n${label}`);
  if (details.status) console.error(`HTTP status: ${details.status}`);
  console.error(`Message: ${details.message}`);
  if (details.type) console.error(`Type: ${details.type}`);
  if (details.code) console.error(`Code: ${details.code}`);
  if (details.subcode) console.error(`Subcode: ${details.subcode}`);
  if (details.traceId) console.error(`Meta trace ID: ${details.traceId}`);

  return details;
}

function printWabaFix() {
  console.error('\nFix: update WHATSAPP_BUSINESS_ID in .env.');
  console.error('Use the WhatsApp Business Account ID (WABA ID), not the phone number ID, app ID, or business portfolio ID.');
  console.error('In Meta, find it at: Developers > your app > WhatsApp > API Setup > WhatsApp Business Account ID.');
  console.error('Also make sure the system user/token has access to that WhatsApp account with whatsapp_business_management.');
}

async function verifyPhoneNumber() {
  if (!phoneId) return;

  const response = await axios.get(`${GRAPH_BASE_URL}/${phoneId}`, {
    ...authConfig,
    params: {
      fields: 'id,verified_name,display_phone_number,quality_rating',
    },
  });

  const phone = response.data;
  console.log(`Phone number OK: ${phone.display_phone_number || phone.id} (${phone.verified_name || 'unnamed'})`);
}

async function verifyWaba() {
  const response = await axios.get(`${GRAPH_BASE_URL}/${wabaId}`, {
    ...authConfig,
    params: {
      fields: 'id,name',
    },
  });

  const waba = response.data;
  console.log(`WABA OK: ${waba.name || 'unnamed'} (${waba.id})`);
}

async function subscribeApp() {
  const response = await axios.post(`${GRAPH_BASE_URL}/${wabaId}/subscribed_apps`, null, authConfig);
  console.log(`Webhook subscription response: ${JSON.stringify(response.data)}`);
}

async function main() {
  console.log(`Using Meta Graph API ${GRAPH_API_VERSION}`);

  try {
    await verifyPhoneNumber();
  } catch (error) {
    printGraphError('Could not verify WHATSAPP_PHONE_ID.', error);
    process.exit(1);
  }

  try {
    await verifyWaba();
  } catch (error) {
    const details = printGraphError('Could not verify WHATSAPP_BUSINESS_ID.', error);

    if (details.code === 100 || details.subcode === 33) {
      printWabaFix();
    }

    process.exit(1);
  }

  try {
    await subscribeApp();
    console.log('Subscribed app to WABA webhooks successfully.');
  } catch (error) {
    const details = printGraphError('Could not subscribe app to WABA webhooks.', error);

    if (details.code === 100 || details.subcode === 33) {
      printWabaFix();
    }

    process.exit(1);
  }
}

main();
