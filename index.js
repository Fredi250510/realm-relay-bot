const { Client, GatewayIntentBits, EmbedBuilder, Colors } = require('discord.js');
const bedrock = require('bedrock-protocol');
const fs = require('fs');

const playerLogFilePath = 'player-log.json';

// Load existing log or create an empty log if the file doesn't exist
let playerLog = [];
if (fs.existsSync(playerLogFilePath)) {
  playerLog = JSON.parse(fs.readFileSync(playerLogFilePath, 'utf-8'));
} else {
  fs.writeFileSync(playerLogFilePath, JSON.stringify(playerLog, null, 2));
}

// Log player join event
function logPlayerJoin(username, device) {
  const logEntry = {
    event: 'join',
    username: username,
    device: device,
    timestamp: new Date().toISOString()
  };
  playerLog.push(logEntry);
  fs.writeFileSync(playerLogFilePath, JSON.stringify(playerLog, null, 2));
}

// Log player leave event
function logPlayerLeave(username, device) {
  const logEntry = {
    event: 'leave',
    username: username,
    device: device,
    timestamp: new Date().toISOString()
  };
  playerLog.push(logEntry);
  fs.writeFileSync(playerLogFilePath, JSON.stringify(playerLog, null, 2));
}


// Load configuration from config.json
let config;
try {
  config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
} catch (err) {
  console.error('[ERROR] Failed to load config.json:', err);
  process.exit(1);
}

const {
  bot_token,
  realm_code,
  reconnect_attempts: maxReconnectAttempts,
  reconnect_interval: reconnectInterval,
  bot_prefix: botPrefix,
  whitelisted_players: whitelistedPlayersArray,
  banned_devices: bannedDevicesArray,
  block_list: blockListArray,
  relay_channel_file: channelFilePath
} = config;

const whitelistedPlayers = new Set(whitelistedPlayersArray);
const bannedDevices = new Set(bannedDevicesArray);
const blockList = new Set(blockListArray);

let realmInvite = realm_code;
let playerNames = new Map();
let joinTimes = new Map();
let messageCounts = new Map();
let autoKickList = new Set();
let reconnectAttempts = 0;
let relayChannel = null;
let mcClient = null;
const connectDisconnectThreshold = 7000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', () => {
  console.log(`[INFO] Logged in as ${client.user.tag}!`);
  loadRelayChannel();
  startChatRelay();
});

client.login(bot_token); // Use token from config.json

// Continue with the rest of the code...

// Modify loadRelayChannel function to use `channelFilePath`
function loadRelayChannel() {
  if (fs.existsSync(channelFilePath)) {
    const data = JSON.parse(fs.readFileSync(channelFilePath, 'utf-8'));
    relayChannel = client.channels.cache.get(data.channelId);
    if (relayChannel) {
      console.log(`[INFO] Relay channel loaded: ${relayChannel}`);
    } else {
      console.log('[WARN] Relay channel not found in cache.');
    }
  } else {
    console.log('[WARN] No relay channel set. Use !set relay to set one.');
  }
}

// Other code as before...


client.on('messageCreate', async (message) => {
  if (message.content.startsWith(`${botPrefix}set relay`)) {
    if (!message.member.permissions.has('MANAGE_CHANNELS')) {
      return sendEmbed(message.channel, "Error", "You don't have permission to use this command.", Colors.Red);
    }

    relayChannel = message.channel;
    fs.writeFileSync(channelFilePath, JSON.stringify({ channelId: relayChannel.id }));
    return sendEmbed(relayChannel, "Relay Channel Set", `Relay channel has been set to ${relayChannel}.`, Colors.Green);
  }

  if (message.content.startsWith(`${botPrefix}prefix`)) {
    const args = message.content.split(' ').slice(1);
    const newPrefix = args[0];

    if (!newPrefix) {
      return sendEmbed(message.channel, "Error", "Please specify a new prefix.", Colors.Red);
    }

    if (newPrefix.length > 3) {
      return sendEmbed(message.channel, "Error", "Prefix cannot be longer than 3 characters.", Colors.Red);
    }

    botPrefix = newPrefix;
    return sendEmbed(message.channel, "Prefix Changed", `Bot prefix has been changed to: \`${botPrefix}\``, Colors.Green);
  }

  if (message.content.startsWith(`${botPrefix}help`)) {
    const helpMessage = `**Available Commands:**
    **${botPrefix}set relay**: Set the channel for relay messages (Requires Manage Channels permission)
    **${botPrefix}prefix <new_prefix>**: Change the bot's command prefix
    **${botPrefix}help**: List available commands
    **${botPrefix}leave**: Disconnect the bot from the realm
    **${botPrefix}join**: Connect the bot to the realm
    **${botPrefix}config player/device <value> true/false**: Configure player/device settings
    **${botPrefix}playerlist**: Show the list of currently online players
    **${botPrefix}say <message>**: Send a message to the Minecraft realm as the bot`;

    return sendEmbed(message.channel, "<:help:1299756222731255869> Help", helpMessage, Colors.Blue);
  }

  if (message.content.startsWith(`${botPrefix}join`)) {
    if (!mcClient) {
      await startChatRelay();
      return sendEmbed(message.channel, "Connected", '<:good:1299751813779554456> Connected to the realm.', Colors.Green);
    } else {
      return sendEmbed(message.channel, "Error", '<:bad:1299751812550758471> The bot is already connected to the realm.', Colors.Red);
    }
  }

  if (message.content.startsWith(`${botPrefix}leave`)) {
    if (mcClient) {
      mcClient.disconnect('User requested to leave the realm.');
      mcClient = null;
      reconnectAttempts = 0; // Reset reconnect attempts

      playerNames.clear();
      joinTimes.clear();
      messageCounts.clear();
      autoKickList.clear();

      return sendEmbed(message.channel, "<:good:1299751813779554456> Disconnected", 'Disconnected from the realm and reset player data.', Colors.Yellow);
    } else {
      return sendEmbed(message.channel, "<:bad:1299751812550758471> Error", 'The bot is not currently connected to a realm.', Colors.Red);
    }
  }

  if (message.content.startsWith(`${botPrefix}playerlist`)) {
    if (playerNames.size === 0) {
      return sendEmbed(message.channel, "<:bad:1299751812550758471> Player List", "No players are currently online.", Colors.Red);
    }

    const onlinePlayers = Array.from(playerNames.values()).join(', ');
    return sendEmbed(message.channel, "<:good:1299751813779554456> Online Players", `Current players online: ${onlinePlayers}`, Colors.Blue);
  }

  if (message.content.startsWith(`${botPrefix}config player/device`)) {
    const args = message.content.split(' ').slice(3);
    const value = args[0];
    const state = args[1] === 'true';

    if (value === 'true' || value === 'false') {
      return sendEmbed(message.channel, "<:good:1299751813779554456> Config Updated", `Player/device configuration set to ${state}.`, Colors.Green);
    } else {
      return sendEmbed(message.channel, "<:bad:1299751812550758471> Error", "Invalid configuration value. Use 'true' or 'false'.", Colors.Red);
    }
  }

  // !say command implementation
  if (message.content.startsWith(`${botPrefix}say `)) {
    if (!mcClient) {
      return sendEmbed(message.channel, "<:bad:1299751812550758471> Error", "The bot is not connected to a Minecraft realm.", Colors.Red);
    }

    const text = message.content.slice(`${botPrefix}say `.length).trim();
    if (!text) {
      return sendEmbed(message.channel, "Error", "You must specify a message to send.", Colors.Red);
    }

    mcClient.queue('command_request', {
      command: `/me ${text}`,
      internal: false,
      version: 66,
      origin: {
        type: 0,
        uuid: "",
        request_id: ""
      }
    });

    return sendEmbed(message.channel, "<:good:1299751813779554456> Message Sent", `Relayed message to Minecraft: ${text}`, Colors.Green);
  }
});

async function sendEmbed(channel, title, description, color = Colors.Blue) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function startChatRelay() {
  try {
    mcClient = bedrock.createClient({
      username: "Test",
      uuid: "",
      offline: false,
      realms: {
        realmInvite
      }
    });

// Set to track players who have already been flagged for spam
const flaggedForSpam = new Set();

mcClient.on('text', (packet) => {
  const type = packet?.type;
  const message = packet?.message;
  const source_name = packet?.source_name;

  // Relay normal chat messages and detect the .leave command
  if (type === 'chat' && message && !message.startsWith('* External') && !message.startsWith('<External>')) {
    const chatMessage = `${source_name} > ${message}`;
    console.log(`[RELAY] ${chatMessage}`);
    if (relayChannel) {
      const embed = new EmbedBuilder()
        .setDescription(chatMessage)
        .setColor(Colors.Blue)
        .setTimestamp();
      relayChannel.send({ embeds: [embed] });
    }

    if (message.trim() === '-leave') {
      console.log('[DISCONNECT] Leave command received from Minecraft chat. Disconnecting...');
      mcClient.disconnect('User issued leave command from Minecraft chat.');
      mcClient = null;
      return;
    }
  }

  // External spam detection (only flag once)
  if (type === 'chat' && (message.startsWith('* External') || message.startsWith('<External>'))) {
    let username = source_name || Array.from(playerNames.values()).pop(); 

    if (!username) {
      console.log('[SPAM] Unable to fetch username for spam detection.'); 
      return;
    }

    // Check if player is already flagged for spam
    if (flaggedForSpam.has(username)) {
      return; // Exit if the player has already been flagged
    }

    // Flag the player to prevent repeated kicks for spam
    flaggedForSpam.add(username);

    // Log spam alert
    console.log(`[SPAM] ${username} was kicked for External Spam!`);

    // Optionally send a message to the relay channel if desired
    if (relayChannel) {
      sendEmbed(
        relayChannel,
        '<:warn:1299755698862690334> Anti Spam',
        `Player ${username} was kicked from the Realm!\nReason: External Spam!`,
        Colors.Red
      );
    }
  }

  // Detect death messages for relay
  if (type === 'translation' && message?.includes('death')) {
    const deathMessage = `Death Message: ${message}`;
    sendEmbed(relayChannel, 'Death Message', deathMessage, Colors.Red);
  }
});

// Reset `flaggedForSpam` when a player leaves the realm
mcClient.on('player_list', (packet) => {
  if (packet.records && Array.isArray(packet.records.records)) {
    switch (packet.records.type) {
      case 'remove':
        packet.records.records.forEach(player => {
          const username = playerNames.get(player.uuid);
          if (username) {
            flaggedForSpam.delete(username); // Reset spam flag when player leaves
          }
        });
        break;
    }
  }
});

mcClient.on('player_list', (packet) => {
  if (packet.records && Array.isArray(packet.records.records)) {
    switch (packet.records.type) {
      case 'add':
        packet.records.records.forEach(player => {
          const Username = player.username;
          const UUID = player.uuid;
          const Device = getDeviceName(player.build_platform);

          if (playerNames.has(UUID)) {
            console.log(`[WARN] Duplicate join detected for ${Username}. Ignoring.`);
            return;
          }

          const currentTime = Date.now();
          const lastJoinTime = joinTimes.get(UUID);

          if (lastJoinTime && (currentTime - lastJoinTime < connectDisconnectThreshold)) {
            const rapidMessage = `Rapid Connect/Disconnect Detected! Username: ${Username}, UUID: ${UUID}`;
            sendEmbed(relayChannel, 'Rapid Connection Alert', rapidMessage, Colors.Yellow);
          }

          const joinMessage = `Player ${Username} joined the Realm!\nDevice: ${Device}`;
          console.log(`[JOIN] ${joinMessage}`); // Log player join to the console
          sendEmbed(relayChannel, '<:join:1299751807110615160> Player Joined' , joinMessage, Colors.Green);

          // Log to JSON file
          logPlayerJoin(Username, Device);

          // Send join message to Minecraft chat
          mcClient.queue('command_request', {
            command: `/me §e${Username}§r joined on §a${Device}§r`,
            internal: false,
            version: 66,
            origin: {
              type: 0,
              uuid: "",
              request_id: ""
            }
          });

          playerNames.set(UUID, Username);
          joinTimes.set(UUID, currentTime);
          checkAndKickPlayer(Device, Username, UUID);
        });
        break;

      case 'remove':
        packet.records.records.forEach(player => {
          const Username = playerNames.get(player.uuid);
          if (Username) {
            const leaveMessage = `Player ${Username} left the Realm!`;
            console.log(`[LEAVE] ${leaveMessage}`); // Log player leave to the console
            sendEmbed(relayChannel, '<:leave:1299751920918986936> Player Left' , leaveMessage, Colors.Yellow);

            // Log to JSON file
            logPlayerLeave(Username);

            // Send leave message to Minecraft chat
            mcClient.queue('command_request', {
              command: `/me §e${Username}§r left the realm`,
              internal: false,
              version: 66,
              origin: {
                type: 0,
                uuid: "",
                request_id: ""
              }
            });

            playerNames.delete(player.uuid);
            joinTimes.delete(player.uuid);
            messageCounts.delete(player.uuid);
          }
        });
        break;
    }
  }
});

    mcClient.on('disconnect', (packet) => {
      console.log('[DISCONNECT] Disconnected from realm. Attempting to reconnect...');
      reconnectAttempts++;
      if (reconnectAttempts <= maxReconnectAttempts) {
        console.log(`[INFO] Reconnect attempt ${reconnectAttempts}...`);
        setTimeout(startChatRelay, reconnectInterval);
      } else {
        console.log('[WARN] Maximum reconnect attempts reached. Stopping connection attempts.');
      }
    });

    mcClient.on('error', (err) => {
      console.error('[ERROR] Error occurred:', err);
    });
  } catch (error) {
    console.error('[ERROR] Failed to start chat relay:', error);
  }
}

function getDeviceName(platform) {
  switch (platform) {
    case 0: return 'Unknown';
    case 1: return 'Android';
    case 2: return 'iOS';
    case 3: return 'OSX (macOS)';
    case 4: return 'FireOS';
    case 5: return 'GearVR';
    case 6: return 'Hololens';
    case 7: return 'Windows x64';
    case 8: return 'Windows x86';
    case 9: return 'Dedicated Server';
    case 10: return 'TvOS (Apple TV)';
    case 11: return 'PlayStation';
    case 12: return 'Nintendo Switch';
    case 13: return 'Xbox';
    case 14: return 'Windows Phone';
    case 15: return 'Linux';
    default: return 'Other';
  }
}

client.on('messageCreate', async (message) => {
  // Check if the message is from the relay channel
  if (message.channel.id === relayChannel?.id && !message.author.bot) {
    // Check if mcClient is connected
    if (!mcClient) {
      return sendEmbed(message.channel, "Error", "The bot is not connected to a Minecraft realm.", Colors.Red);
    }
    
    // Relay the message to Minecraft chat using the command format
    const userTag = message.author.tag; // Discord user's tag (e.g., username#1234)
    const relayMessage = message.content; // The actual message from Discord
    
    mcClient.queue('command_request', {
      command: `/me §7<${userTag}> §8§l>>§r ${relayMessage}`,
      internal: false,
      version: 66,
      origin: {
        type: 0,
        uuid: "",
        request_id: ""
      }
    });

    console.log(`[DISCORD RELAY] Sent from Discord to Minecraft: ${userTag}: ${relayMessage}`);
  }

  // Other existing commands (e.g., !set relay, !prefix) remain unchanged...
});


function checkAndKickPlayer(device, username, uuid) {
  if (bannedDevices.has(device) || blockList.has(username)) {
    const kickMessage = `Player ${username} (Device: ${device}) has been kicked from the realm.`;
    console.log(`[KICK] ${kickMessage}`); // Log kick messages to the console

    // Send an embed message to the relay channel
    sendEmbed(relayChannel, '<:warn:1299755698862690334> Player Kicked', kickMessage, Colors.Red);

    // Add the UUID to the autoKickList
    autoKickList.add(uuid);

    // Queue the kick command
    mcClient.queue('command_request', {
      command: `/kick ${username} You are not allowed to play on this realm.`,
      internal: false,
      version: 66,
      origin: {
        type: 0,
        uuid: "",
        request_id: ""
      }
    });

  }
}