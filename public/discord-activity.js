const activityBoot = location.pathname === '/discord' || location.pathname === '/activity' || new URLSearchParams(location.search).has('discord_activity');

function status(message, mode = 'info') {
  window.WordVaultApi?.setDiscordStatus?.(message, mode);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `${url} failed (${res.status})`);
  return data;
}

function avatarUrl(user) {
  if (!user?.id || !user?.avatar) return '';
  const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
  return `/api/discord/avatar/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}?size=128`;
}

function userName(user) {
  return user?.global_name || user?.display_name || user?.username || 'Discord Player';
}

async function waitForWordVaultApi() {
  const started = Date.now();
  while (!window.WordVaultApi && Date.now() - started < 5000) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!window.WordVaultApi) throw new Error('Word Vault client did not finish loading.');
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function bootDiscordActivity() {
  if (!activityBoot) return;
  await waitForWordVaultApi();
  status('Discord Activity: loading…');

  const config = await fetchJson('/api/discord/config');
  if (!config.enabled || !config.clientId) {
    status('Discord Activity needs DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET on Render.', 'error');
    return;
  }

  let DiscordSDK;
  try {
    ({ DiscordSDK } = await import(config.sdkProxy || '/discord-sdk/embedded-app-sdk.js'));
  } catch (err) {
    status(`Could not load Discord SDK: ${err.message}`, 'error');
    return;
  }

  const sdk = new DiscordSDK(config.clientId);
  const instanceId = sdk.instanceId || new URLSearchParams(location.search).get('instance_id') || '';
  status('Discord Activity: connecting to Discord…');

  try {
    await withTimeout(sdk.ready(), 12000, 'Discord SDK ready');
  } catch (err) {
    status('Open this from Discord’s Activity shelf, not a normal browser tab.', 'error');
    return;
  }

  let authUser = null;
  let accessToken = '';
  try {
    const { code } = await sdk.commands.authorize({
      client_id: config.clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify']
    });
    const token = await fetchJson('/api/discord/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    accessToken = token.access_token;
    const auth = await sdk.commands.authenticate({ access_token: accessToken });
    authUser = auth?.user || null;
    if (!authUser && accessToken) authUser = await fetchJson('/api/discord/me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken })
    });
  } catch (err) {
    status(`Discord login failed: ${err.message}`, 'error');
    return;
  }

  let channelName = '';
  try {
    if (sdk.channelId && sdk.guildId) {
      const channel = await sdk.commands.getChannel({ channel_id: sdk.channelId });
      channelName = channel?.name || '';
    }
  } catch (_) {}

  const userId = authUser?.id || `guest_${Math.random().toString(36).slice(2)}`;
  const token = `discord_${userId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const key = instanceId || `${sdk.guildId || 'dm'}_${sdk.channelId || 'unknown'}`;
  status(channelName ? `Discord Activity: joining #${channelName}…` : 'Discord Activity: joining room…');

  window.WordVaultApi.joinDiscordActivityRoom({
    instanceId: key,
    guildId: sdk.guildId || '',
    channelId: sdk.channelId || '',
    discordUserId: userId,
    name: userName(authUser),
    avatar: authUser?.avatar_url || avatarUrl(authUser),
    token
  });

  status(channelName ? `Discord Activity connected: #${channelName}` : 'Discord Activity connected.');
  window.WordVaultApi.clearDiscordStatusSoon?.();
}

bootDiscordActivity().catch(err => {
  status(`Discord Activity error: ${err.message || err}`, 'error');
});
