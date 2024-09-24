const { Client, GatewayIntentBits, EmbedBuilder, Colors } = require('discord.js');
const bedrock = require('bedrock-protocol');
const fs = require('fs');

let realmInvite = "<realm-code>"; // Default Realm code
const playerNames = new Map(); // Store player UUIDs and usernames
const joinTimes = new Map(); // Store player join times
const messageCounts = new Map(); // Store player message counts (for spam filter)
const autoKickList = new Set(); // Store auto-kick list (UUIDs)
const whitelistedPlayers = new Set(['Player1', 'Player2']); // Example whitelisted usernames
const bannedDevices = new Set(['Device', 'Device']); // Banned devices
const blockList = new Set(['BlockedPlayer1', 'BlockedPlayer2']); // Blocked usernames to auto-kick
let reconnectAttempts = 0;
const maxReconnectAttempts = 3;
const reconnectInterval = 5000; // 5 seconds interval between reconnects
let relayChannel = null; // Channel to send relay messages
let mcClient = null; // Minecraft client instance
const connectDisconnectThreshold = 9000; // 9 seconds threshold for quick connects/disconnects

const channelFilePath = 'relayChannel.json'; // File to store relay channel ID
const realmCodeFilePath = 'realm-codes.json'; // File to store realm codes

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  loadRelayChannel(); // Load the relay channel from the file
  startChatRelay(); // Start the chat relay
});

client.login('<bot-token>'); // Replace with your bot token

client.on('messageCreate', async (message) => {
  if (message.content.startsWith('!set relay')) {
    if (!message.member.permissions.has('MANAGE_CHANNELS')) {
      return sendEmbed(message.channel, "Error", "You don't have permission to use this command.", Colors.Red);
    }

    relayChannel = message.channel;
    fs.writeFileSync(channelFilePath, JSON.stringify({ channelId: relayChannel.id })); // Save channel ID
    return sendEmbed(relayChannel, "Relay Channel Set", `Relay channel has been set to ${relayChannel}.`, Colors.Green);
  }

  if (message.content.startsWith('!help')) {
    const helpMessage = `**Available Commands:**
    - **!set relay**: Set the channel for relay messages (Requires Manage Channels permission)
    - **!help**: List available commands
    - **!leave**: Disconnect the bot from the realm
    - **!join**: Connect the bot to the realm
    - **!config player/device <value> true/false**: Configure player/device settings`;

    return sendEmbed(message.channel, "Help", helpMessage, Colors.Blue);
  }

  if (message.content.startsWith('!join')) {
    if (!mcClient) {
      await startChatRelay(); // Start the chat relay
      return sendEmbed(message.channel, "Connected", 'Connected to the realm.', Colors.Green);
    } else {
      return sendEmbed(message.channel, "Error", 'The bot is already connected to the realm.', Colors.Red);
    }
  }

  if (message.content.startsWith('!leave')) {
    if (mcClient) {
      mcClient.disconnect('User requested to leave the realm.');
      mcClient = null; // Clear the client instance
      reconnectAttempts = maxReconnectAttempts; // Prevent auto-reconnect

      // Reset the join times and player names to avoid duplicate join flags
      playerNames.clear();  // Clear the player names
      joinTimes.clear();    // Clear the join times
      messageCounts.clear(); // Clear the message counts
      autoKickList.clear();  // Clear the auto-kick list

      return sendEmbed(message.channel, "Disconnected", 'Disconnected from the realm and reset player data.', Colors.Yellow);
    } else {
      return sendEmbed(message.channel, "Error", 'The bot is not currently connected to a realm.', Colors.Red);
    }
  }

  // Command to configure player/device settings
  if (message.content.startsWith('!config player/device')) {
    const args = message.content.split(' ').slice(3);
    const value = args[0];
    const state = args[1] === 'true';

    if (value === 'true' || value === 'false') {
      // Add logic to configure based on the value and state
      // Example implementation: Here just responding with an embed
      return sendEmbed(message.channel, "Config Updated", `Player/device configuration set to ${state}.`, Colors.Green);
    } else {
      return sendEmbed(message.channel, "Error", "Invalid configuration value. Use 'true' or 'false'.", Colors.Red);
    }
  }
});

// Function to validate realm codes (15 characters long)
function isValidRealmCode(code) {
  return /^[A-Za-z0-9]{15}$/.test(code); // Alphanumeric, 15 characters long
}

function loadRelayChannel() {
  if (fs.existsSync(channelFilePath)) {
    const data = JSON.parse(fs.readFileSync(channelFilePath, 'utf-8'));
    relayChannel = client.channels.cache.get(data.channelId);
    if (relayChannel) {
      console.log(`Relay channel loaded: ${relayChannel}`);
    } else {
      console.log('Relay channel not found in cache.');
    }
  } else {
    console.log('No relay channel set. Use !set relay to set one.');
  }
}

// Function to send messages as embeds
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

    mcClient.on('text', (packet) => {
      const type = packet?.type;
      const message = packet?.message;
      const source_name = packet?.source_name;

      if (type === 'chat' && message && !message.startsWith('* External')) {
        const chatMessage = `<${source_name}> ${message}`;
        if (relayChannel) {
          const embed = new EmbedBuilder()
            .setDescription(chatMessage)
            .setColor(Colors.Blue)
            .setTimestamp();
          relayChannel.send({ embeds: [embed] });
        }
      }

      // Detect death messages
      if (type === 'translation' && message?.includes('death')) {
        const deathMessage = `Death Message: ${message}`;
        sendEmbed(relayChannel, 'Death Message', deathMessage, Colors.Red);
      }
    });

    mcClient.on('player_list', (packet) => {
      if (packet.records && Array.isArray(packet.records.records)) {
        switch (packet.records.type) {
          case 'add': // When a player joins
            packet.records.records.forEach(player => {
              const Username = player.username;
              const UUID = player.uuid;
              const XUID = player.xbox_user_id;
              const Device = getDeviceName(player.build_platform);

              // Prevent duplicate join logging
              if (playerNames.has(UUID)) {
                console.log(`Duplicate join detected for ${Username}. Ignoring.`);
                return;
              }

              const currentTime = Date.now();
              const lastJoinTime = joinTimes.get(UUID);

              // Check for rapid connection/disconnection
              if (lastJoinTime && (currentTime - lastJoinTime < connectDisconnectThreshold)) {
                const rapidMessage = `Rapid Connect/Disconnect Detected! Username: ${Username}, UUID: ${UUID}, XUID: ${XUID}`;
                sendEmbed(relayChannel, 'Rapid Connection Alert', rapidMessage, Colors.Yellow);
              }

              const joinMessage = `Player ${Username} joined on ${Device}`;
              sendEmbed(relayChannel, 'Player Joined', joinMessage);
              console.log(joinMessage); // Log to console

              playerNames.set(UUID, Username);
              joinTimes.set(UUID, currentTime); // Update join time

              // Log the realm code on join
              logRealmCode(realmInvite); // Log the current realm code

              // Check device and block list for kicks
              checkAndKickPlayer(Device, Username, UUID);

              // Check for Windows players
              if (Device === 'Windows') {
                sendEmbed(relayChannel, 'Possible Bot!', `Username: ${Username}, UUID: ${UUID}, XUID: ${XUID}`, Colors.Red);
              }
            });
            break;

          case 'remove': // When a player leaves
            packet.records.records.forEach(player => {
              const Username = playerNames.get(player.uuid);
              const leaveMessage = `Player ${Username} has left.`;
              sendEmbed(relayChannel, 'Player Left', leaveMessage, Colors.Grey);
              playerNames.delete(player.uuid); // Remove from tracked players
              joinTimes.delete(player.uuid); // Remove join time
            });
            break;
        }
      }
    });

    mcClient.on('end', () => {
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        console.log('Disconnected from the realm. Attempting to reconnect...');
        setTimeout(startChatRelay, reconnectInterval);
      } else {
        console.log('Maximum reconnect attempts reached. Stopping auto-reconnect.');
      }
    });

  } catch (error) {
    console.error('Failed to start Minecraft chat relay:', error);
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      console.log(`Reconnect attempt ${reconnectAttempts}...`);
      setTimeout(startChatRelay, reconnectInterval);
    }
  }
}

function resetClient() {
  if (mcClient) {
    mcClient.disconnect();
    mcClient = null; // Reset Minecraft client
  }

  // Clear data
  playerNames.clear();
  joinTimes.clear();
  messageCounts.clear();
  autoKickList.clear();
}

function checkAndKickPlayer(device, username, uuid) {
  if (bannedDevices.has(device)) {
    const kickMessage = `Kicked player ${username} for using banned device: ${device}.`;
    mcClient.write('kick_player', { uuid, reason: 'Banned Device' });
    sendEmbed(relayChannel, 'Player Kicked', kickMessage, Colors.Red);
  }

  if (blockList.has(username)) {
    const kickMessage = `Kicked blocked player ${username}.`;
    mcClient.write('kick_player', { uuid, reason: 'Blocked Player' });
    sendEmbed(relayChannel, 'Player Kicked', kickMessage, Colors.Red);
  }
}

// Function to log realm codes to a JSON file
function logRealmCode(code) {
  const logData = { realmCode: code, timestamp: new Date().toISOString() };
  fs.writeFileSync(realmCodeFilePath, JSON.stringify(logData, null, 2)); // Write to realm-codes.json
  console.log(`Realm code logged: ${JSON.stringify(logData)}`);
}

// Function to convert platform build number to device name
function getDeviceName(buildPlatform) {
  const deviceMap = {
    7: 'Windows',
    1: 'iOS',
    2: 'Android',
    3: 'PlayStation',
    4: 'Switch',
    5: 'Xbox',
    6: 'Linux',
  };

  return deviceMap[buildPlatform] || 'Unknown';
}
