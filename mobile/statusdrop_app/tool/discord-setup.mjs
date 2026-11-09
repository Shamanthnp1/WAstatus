#!/usr/bin/env node
// Builds the StatusDrop community Discord server: roles, categories,
// channels, permissions, and the pinned welcome / rules / download / FAQ posts.
//
// Discord bots can't create servers, so first create an empty server in the
// Discord app, add a bot to it with the Administrator permission (it posts
// in read-only channels), then run this once. Remove the bot afterwards if
// you like. Safe to run again: it skips roles and channels that already
// exist (matched by name).
//
//   Preview, no token needed:
//     node mobile/statusdrop_app/tool/discord-setup.mjs --dry-run
//   Build (the token never goes on the command line):
//     node --env-file=.env.discord mobile/statusdrop_app/tool/discord-setup.mjs
//
// .env.discord (gitignored by the root ".env.*" rule):
//   DISCORD_BOT_TOKEN=...   Developer Portal > your app > Bot > Reset Token
//   DISCORD_GUILD_ID=...    right-click the server > Copy Server ID
//                           (turn on Settings > Advanced > Developer Mode)

const API = 'https://discord.com/api/v10';
const DRY_RUN = process.argv.includes('--dry-run');
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;

const MAX_PAGE = 'https://wastatusvideo.com/max';
const PLAY = 'https://play.google.com/store/apps/details?id=com.wastatusvideo.statusdrop';
const SITE = 'https://wastatusvideo.com';
const SOURCE = 'https://github.com/Shamanthnp1/WAstatus';

// Permission bits (https://discord.com/developers/docs/topics/permissions).
const P = {
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS: 1n << 40n,
};
const bits = (...names) => names.reduce((sum, name) => sum | P[name], 0n).toString();
const READ_ONLY = bits('SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS');

const TYPE = { TEXT: 0, CATEGORY: 4 };

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------
const ROLES = [
  {
    name: 'Moderator',
    colors: { primary_color: 0x137a3e },
    hoist: true,
    mentionable: true,
    permissions: bits(
      'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'MANAGE_NICKNAMES',
      'MANAGE_THREADS', 'MODERATE_MEMBERS', 'VIEW_CHANNEL', 'SEND_MESSAGES',
      'READ_MESSAGE_HISTORY', 'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS',
    ),
  },
  {
    name: 'MAX Tester',
    colors: { primary_color: 0x6aefa9 },
    hoist: true,
    mentionable: true,
  },
];

// access: 'public' | 'readOnly' (only moderators post) | 'staff' (moderators only)
const CATEGORIES = [
  {
    name: '📌 START HERE',
    channels: [
      { name: 'welcome', access: 'readOnly', topic: 'Start here: what StatusDrop is and where to get it.', post: 'welcome' },
      { name: 'rules', access: 'readOnly', topic: 'Read before posting.', post: 'rules' },
      { name: 'announcements', access: 'readOnly', topic: 'New versions and important news.' },
      { name: 'download-max', access: 'readOnly', topic: `StatusDrop MAX download: ${MAX_PAGE}`, post: 'download' },
    ],
  },
  {
    name: '🛟 HELP',
    channels: [
      { name: 'faq', access: 'readOnly', topic: 'Common questions, answered.', post: 'faq' },
      { name: 'help-play-version', access: 'public', slowmode: 10, topic: 'Help with StatusDrop from Google Play (StatusDrop number delivery).' },
      { name: 'help-max', access: 'public', slowmode: 10, topic: 'Help with StatusDrop MAX: Message yourself and bot delivery.' },
      { name: 'bug-reports', access: 'public', slowmode: 30, topic: 'Phone model, Android version, app version (Play or MAX), what you did, what happened.' },
    ],
  },
  {
    name: '💬 COMMUNITY',
    channels: [
      { name: 'general', access: 'public', topic: 'Chat about anything StatusDrop.' },
      { name: 'feature-requests', access: 'public', slowmode: 30, topic: 'Ideas for StatusDrop. One idea per message, please.' },
      { name: 'show-your-status', access: 'public', slowmode: 30, topic: 'Share how your HD Status turned out.' },
    ],
  },
  {
    name: '🔒 STAFF',
    access: 'staff',
    channels: [
      { name: 'mod-chat', access: 'staff', topic: 'Moderators only.' },
      { name: 'mod-log', access: 'staff', topic: 'Notes on warnings, timeouts and bans.' },
    ],
  },
];

const POSTS = {
  welcome: [
    '# Welcome to the StatusDrop community 👋',
    'StatusDrop is a free Android app that compresses your videos **on your phone** and sends them to your WhatsApp, ready to post to Status in HD.',
    '',
    '**Get the app**',
    `• Google Play version: ${PLAY}`,
    `• StatusDrop MAX (adds sending from your own WhatsApp number): ${MAX_PAGE}`,
    '',
    '**Where to go**',
    '• Read the rules first.',
    '• Questions about the Play version go in the Play help channel; MAX questions go in the MAX help channel.',
    '• Found a bug? Use the bug reports channel.',
    '• New versions are posted in announcements.',
    '',
    `Website: ${SITE} · Source code: ${SOURCE}`,
  ].join('\n'),
  rules: [
    '# Rules',
    '1. Be kind. No harassment, hate speech or personal attacks.',
    '2. No spam, ads, or invite links to other servers.',
    '3. Never post phone numbers, linking codes or activation codes. Blur them in screenshots.',
    '4. No pirated, modded or "GB" WhatsApp apps, and no links to APKs other than the official MAX page.',
    '5. Keep each channel on its topic.',
    '6. Follow Discord\'s Terms of Service and Community Guidelines.',
    '',
    'Moderators may remove messages, time out or ban members who break these rules.',
    'StatusDrop is an independent app and is not affiliated with WhatsApp or Meta.',
  ].join('\n'),
  download: [
    '# Download StatusDrop MAX',
    `👉 ${MAX_PAGE}`,
    '',
    'MAX has everything in the Google Play version, plus two ways to send clips from a number you own:',
    '• **Message yourself**: your phone sends the clips to your own "Message yourself" chat.',
    '• **Second number as a bot**: send your bot the code and it replies with your clips.',
    '',
    'Only download MAX from the page above. MAX does not update itself: when a new version is announced, download it again from that page.',
    '',
    '⚠️ The self-host methods use an unofficial WhatsApp connection. WhatsApp may log out or restrict numbers that behave like bots, and brand-new numbers are the most at risk.',
  ].join('\n'),
  faq: [
    '# FAQ',
    '**Is StatusDrop free?** Yes, both the Google Play version and MAX.',
    '',
    '**Why is my Status still blurry?** In WhatsApp, open Settings > Storage and data and set both Media upload quality and Auto-download quality to HD quality. Then download the clip, send it again from Gallery, and forward that new copy to My Status. Forwarding the copy you received straight to Status makes WhatsApp compress it again.',
    '',
    '**Which quality should I pick?** 1080p HD makes 29-second parts. 1080p with no splitting makes one clip up to 90 seconds but needs fast internet. 720p makes longer parts.',
    '',
    `**What is MAX?** A separate free download from ${MAX_PAGE} that adds delivery from your own WhatsApp number. It installs next to the Play version.`,
    '',
    '**Does StatusDrop upload my original video?** No. Compression happens on your phone. With the StatusDrop number, only the finished clips upload. With MAX self-host methods, nothing uploads to StatusDrop.',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Discord REST helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, route, body) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${API}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'StatusDropSetup (https://wastatusvideo.com, 1.0)',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 6) {
      const wait = Number(response.headers.get('retry-after') ?? '1');
      await sleep(Math.ceil(wait * 1000) + 250);
      continue;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`${method} ${route} failed (${response.status}): ${data?.message ?? text}`);
    }
    return data;
  }
}

function overwritesFor(access, everyoneId, moderatorId) {
  if (access === 'staff') {
    return [
      { id: everyoneId, type: 0, deny: P.VIEW_CHANNEL.toString() },
      { id: moderatorId, type: 0, allow: bits('VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY') },
    ];
  }
  if (access === 'readOnly') {
    return [
      { id: everyoneId, type: 0, deny: READ_ONLY, allow: bits('ADD_REACTIONS', 'READ_MESSAGE_HISTORY') },
      { id: moderatorId, type: 0, allow: bits('SEND_MESSAGES') },
    ];
  }
  return [];
}

function printPlan() {
  console.log('Roles:');
  for (const role of ROLES) console.log(`  @${role.name}`);
  for (const category of CATEGORIES) {
    console.log(`\n${category.name}${category.access === 'staff' ? '  (moderators only)' : ''}`);
    for (const channel of category.channels) {
      const notes = [
        channel.access === 'readOnly' ? 'read-only' : null,
        channel.access === 'staff' ? 'moderators only' : null,
        channel.slowmode ? `slowmode ${channel.slowmode}s` : null,
        channel.post ? `pinned ${channel.post} post` : null,
      ].filter(Boolean);
      console.log(`  #${channel.name}${notes.length ? `  (${notes.join(', ')})` : ''}`);
    }
  }
  console.log('\nServer settings: verification level Medium, explicit media filter for all members,');
  console.log('notifications for @mentions only, system messages in #welcome, a permanent invite.');
}

async function main() {
  if (DRY_RUN) {
    printPlan();
    return;
  }
  if (!TOKEN || !GUILD) {
    console.error('Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID (see the top of this file), or use --dry-run.');
    process.exit(1);
  }

  const guild = await api('GET', `/guilds/${GUILD}`);
  console.log(`Server: ${guild.name}`);

  // Roles
  const roles = await api('GET', `/guilds/${GUILD}/roles`);
  const everyoneId = GUILD; // the @everyone role shares the server's id
  const roleIds = {};
  for (const role of ROLES) {
    const existing = roles.find((r) => r.name === role.name);
    roleIds[role.name] = existing?.id ?? (await api('POST', `/guilds/${GUILD}/roles`, role)).id;
    console.log(`  role @${role.name}: ${existing ? 'exists' : 'created'}`);
  }
  const moderatorId = roleIds.Moderator;

  // Categories and channels
  const channels = await api('GET', `/guilds/${GUILD}/channels`);
  const byName = (name, type, parentId) =>
    channels.find((c) => c.name === name && c.type === type && (parentId === undefined || c.parent_id === parentId));
  const created = {};
  let position = 0;
  for (const category of CATEGORIES) {
    let parent = byName(category.name, TYPE.CATEGORY);
    if (!parent) {
      parent = await api('POST', `/guilds/${GUILD}/channels`, {
        name: category.name,
        type: TYPE.CATEGORY,
        position: position++,
        permission_overwrites: overwritesFor(category.access ?? 'public', everyoneId, moderatorId),
      });
      channels.push(parent);
    }
    console.log(`\n${category.name}`);
    for (const channel of category.channels) {
      let existing = byName(channel.name, TYPE.TEXT, parent.id);
      if (!existing) {
        existing = await api('POST', `/guilds/${GUILD}/channels`, {
          name: channel.name,
          type: TYPE.TEXT,
          parent_id: parent.id,
          topic: channel.topic,
          rate_limit_per_user: channel.slowmode ?? 0,
          permission_overwrites: overwritesFor(channel.access, everyoneId, moderatorId),
        });
        channels.push(existing);
        console.log(`  #${channel.name}: created`);
        if (channel.post) {
          const message = await api('POST', `/channels/${existing.id}/messages`, {
            content: POSTS[channel.post],
            allowed_mentions: { parse: [] },
          });
          try {
            await api('PUT', `/channels/${existing.id}/messages/pins/${message.id}`);
          } catch {
            await api('PUT', `/channels/${existing.id}/pins/${message.id}`); // older route
          }
        }
      } else {
        console.log(`  #${channel.name}: exists (left as it is)`);
      }
      created[channel.name] = existing;
    }
  }

  // Server settings
  await api('PATCH', `/guilds/${GUILD}`, {
    verification_level: 2, // Medium: verified email and a Discord account older than 5 minutes
    explicit_content_filter: 2, // scan media from all members
    default_message_notifications: 1, // only @mentions
    system_channel_id: created.welcome?.id,
  });
  console.log('\nServer settings updated.');

  // A permanent invite to #welcome, for the website and the app's MAX page.
  const invite = await api('POST', `/channels/${created.welcome.id}/invites`, {
    max_age: 0,
    max_uses: 0,
    unique: false,
  });
  console.log(`\nInvite link: https://discord.gg/${invite.code}`);
  console.log('Done. Give yourself and your moderators the Moderator role, then you can remove the bot.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
