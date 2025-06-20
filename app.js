// Forteil Hackathon Bot - Production Ready Version with Daily Reminder Toggle
const { App } = require('@slack/bolt');
const { Pool } = require('pg');
const cron = require('node-cron');
require('dotenv').config();

// Configuration - alle settings samlet
const CONFIG = {
  dadJokeChance: parseFloat(process.env.DAD_JOKE_CHANCE) || 0.25,
  adminUserId: process.env.ADMIN_USER_ID || 'U07M4BA86LF',
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  dbTimeout: parseInt(process.env.DB_TIMEOUT) || 10000,
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000, // 1 min
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX) || 10
};

// Daily reminder state - will be loaded from database on startup
let dailyReminderEnabled = true;

// Request tracking for debugging
let requestCounter = 0;
const generateRequestId = () => `req_${Date.now()}_${++requestCounter}`;

// Rate limiting storage
const rateLimitStore = new Map();

// Database connection with optimized settings
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10, // maximum number of clients in pool
  idleTimeoutMillis: 30000, // close idle clients after 30 seconds
  connectionTimeoutMillis: CONFIG.dbTimeout,
});

// Graceful pool shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  port: process.env.PORT || 3000
});

// Shared constants - no duplication
const MOTIVATIONAL_MESSAGES = [
  (total) => `🌅 God morgen, idé-maskiner, alle jer vidunderlige Forteilees! Vi har ${total} fantastiske idéer indtil nu!`,
  (total) => `☕ Kaffe-tid! Vores idé-tæller står på ${total} - skal vi runde op, kære Forteilees?`,
  (total) => `🧠 Dagens brainstorm-update: ${total} idéer og counting, fantastiske Forteilees!`,
  (total) => `⚡ Lightning round! Vi har ${total} idéer - hvad kommer der næst, dygtige Forteilees?`,
  (total) => `🎯 Målrettet opdatering: ${total} idéer på tavlen, vidunderlige Forteilees!`
];

const FUNNY_RESPONSES = [
  "🚀 Den idé fik lige min indre nørd til at juble!",
  "💡 *Chef's kiss* - det er simpelt og smart!",
  "🤖 Beep boop! Min algoritme siger: GENIAL!",
  "⚡ Den idé sparkler som fresh commits på fredag eftermiddag!",
  "🎯 Bulls-eye! Det rammer lige i Forteil-filosofien!",
  "🔥 Hot take alert! Den her idé er 🔥🔥🔥",
  "🎪 *Standing ovation fra alle mine virtuelle personligheder*",
  "💎 Rare gem spotted! Den her går direkte til favorit-listen!",
  "🎨 Kreativitet level: Over 9000!",
  "🍕 Den idé fortjener pizza som belønning!"
];

const DAD_JOKES = [
  "Hvorfor elsker programmører mørke? Fordi lys tiltrækker bugs! 🐛",
  "Hvad siger en AI når den er træt? 'Jeg trænger til at reboote!' 💤",
  "Hvorfor gik API'et til tandlægen? Det havde dårlige endpoints! 🦷",
  "Hvad kalder man en hacker der laver kaffe? En Java developer! ☕",
  "Hvorfor blev robotten fyret? Den havde for mange glitches i sin performance review! 🤖",
  "Hvad er forskellen på en programmør og en almindelig person? Programmøren tænker der er 10 typer mennesker i verden!",
  "Hvorfor gik udvikler til psykologen? Hun havde for mange issues!",
  "Hvad siger en database til en anden? Skal vi JOIN sammen?"
];

const REACTIONS = ['rocket', 'bulb', 'zap', 'dart', 'fire', 'gem', 'star', 'clap', 'tada', 'muscle'];

// Utility functions
const logWithContext = (level, message, context = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...context
  };
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`, context);
  return logEntry;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate limiting
const isRateLimited = (userId) => {
  const now = Date.now();
  const userHistory = rateLimitStore.get(userId) || [];
  
  // Remove old entries
  const validEntries = userHistory.filter(time => now - time < CONFIG.rateLimitWindow);
  
  if (validEntries.length >= CONFIG.rateLimitMax) {
    return true;
  }
  
  validEntries.push(now);
  rateLimitStore.set(userId, validEntries);
  return false;
};

// Database functions with error handling and optimization
const executeWithRetry = async (operation, maxRetries = CONFIG.maxRetries) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      logWithContext('error', `Database operation failed (attempt ${attempt}/${maxRetries})`, {
        error: error.message,
        stack: error.stack
      });
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      await sleep(1000 * attempt); // Exponential backoff
    }
  }
};

// Daily reminder toggle functions
const getDailyReminderStatus = async (requestId) => {
  return executeWithRetry(async () => {
    logWithContext('info', 'Fetching daily reminder status', { requestId });
    
    const query = `
      SELECT setting_value 
      FROM bot_settings 
      WHERE setting_key = 'daily_reminder_enabled'
      LIMIT 1
    `;
    
    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      // Default to enabled if no setting exists
      return true;
    }
    
    return result.rows[0].setting_value === 'true';
  });
};

const setDailyReminderStatus = async (enabled, requestId) => {
  return executeWithRetry(async () => {
    logWithContext('info', 'Setting daily reminder status', { 
      requestId, 
      enabled 
    });
    
    const query = `
      INSERT INTO bot_settings (setting_key, setting_value, updated_at)
      VALUES ('daily_reminder_enabled', $1, NOW())
      ON CONFLICT (setting_key) 
      DO UPDATE SET 
        setting_value = $1,
        updated_at = NOW()
    `;
    
    await pool.query(query, [enabled.toString()]);
    
    // Update in-memory state
    dailyReminderEnabled = enabled;
    
    logWithContext('info', 'Daily reminder status updated', { 
      requestId, 
      enabled 
    });
  });
};

// Optimized single-query stats function
const getIdeaStats = async (requestId) => {
  return executeWithRetry(async () => {
    logWithContext('info', 'Fetching idea statistics', { requestId });
    
    const query = `
      WITH category_stats AS (
        SELECT category, COUNT(*) as count
        FROM ideas 
        GROUP BY category 
        ORDER BY count DESC
      ),
      user_stats AS (
        SELECT username, COUNT(*) as idea_count
        FROM ideas 
        GROUP BY username 
        ORDER BY idea_count DESC
        LIMIT 5
      ),
      total_stats AS (
        SELECT COUNT(*) as total FROM ideas
      )
      SELECT 
        (SELECT total FROM total_stats) as total,
        (SELECT json_agg(json_build_object('category', category, 'count', count)) FROM category_stats) as categories,
        (SELECT json_agg(json_build_object('username', username, 'idea_count', idea_count)) FROM user_stats) as top_users
    `;
    
    const result = await pool.query(query);
    const stats = result.rows[0];
    
    // Format results
    return {
      total: parseInt(stats.total) || 0,
      categories: stats.categories || [],
      topUsers: stats.top_users || []
    };
  });
};

const saveIdea = async (userId, username, text, category, messageTs, channelId, requestId) => {
  return executeWithRetry(async () => {
    logWithContext('info', 'Saving new idea', { 
      requestId, 
      userId, 
      username, 
      category,
      textLength: text.length 
    });
    
    const query = `
      INSERT INTO ideas (user_id, username, idea_text, category, message_ts, channel_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id
    `;
    const result = await pool.query(query, [userId, username, text, category, messageTs, channelId]);
    return result.rows[0].id;
  });
};

const saveReaction = async (ideaId, reactionType, responseText, requestId) => {
  return executeWithRetry(async () => {
    const query = `
      INSERT INTO reactions (idea_id, reaction_type, response_text, created_at)
      VALUES ($1, $2, $3, NOW())
    `;
    await pool.query(query, [ideaId, reactionType, responseText]);
    logWithContext('info', 'Reaction saved', { requestId, ideaId, reactionType });
  });
};

// Enhanced categorization
const categorizeIdea = (text) => {
  const lowerText = text.toLowerCase();
  
  const categories = [
    {
      name: '🤖 AI & Automatisering',
      emoji: 'robot_face',
      keywords: ['ai', 'chatbot', 'automatiser', 'machine learning', 'intelligent', 'smart']
    },
    {
      name: '🔗 Integrationer',
      emoji: 'link',
      keywords: ['slack', 'integration', 'api', 'connect', 'sync', 'webhook']
    },
    {
      name: '⚙️ Procesoptimering',
      emoji: 'gear',
      keywords: ['process', 'workflow', 'effektiv', 'optimering', 'automation', 'streamline']
    },
    {
      name: '📊 Data & Visualisering',
      emoji: 'bar_chart',
      keywords: ['dashboard', 'rapporter', 'data', 'analytics', 'metrics', 'visualization']
    },
    {
      name: '🎨 UI/UX Forbedringer',
      emoji: 'art',
      keywords: ['interface', 'design', 'bruger', 'frontend', 'ui', 'ux', 'mobile']
    }
  ];
  
  for (const category of categories) {
    if (category.keywords.some(keyword => lowerText.includes(keyword))) {
      return category;
    }
  }
  
  return { name: '💡 Kreative Løsninger', emoji: 'bulb' };
};

// Generate motivational message
const generateMotivationalMessage = (stats) => {
  const messageGenerator = MOTIVATIONAL_MESSAGES[Math.floor(Math.random() * MOTIVATIONAL_MESSAGES.length)];
  const randomMessage = messageGenerator(stats.total);
  
  const topCategory = stats.categories.length > 0 ? stats.categories[0] : null;
  const categoryText = topCategory ? 
    `\n🏆 Mest populære kategori: ${topCategory.category} (${topCategory.count} idéer)` : '';
  
  return `${randomMessage}${categoryText}\n\n💡 Brug /hackathon-stats for fuld oversigt!\n\n<!channel> Få delt flere idéer! 🚀`;
};

// Main message handler with comprehensive error handling
app.message(async ({ message, client }) => {
  const requestId = generateRequestId();
  
  try {
    // Basic validation
    if (message.bot_id) return;
    
    if (process.env.HACKATHON_CHANNEL_ID && message.channel !== process.env.HACKATHON_CHANNEL_ID) {
      return;
    }
    
    if (!message.text || !message.text.toLowerCase().startsWith('ide')) {
      return;
    }
    
    // Rate limiting
    if (isRateLimited(message.user)) {
      logWithContext('warn', 'User rate limited', { requestId, userId: message.user });
      return;
    }
    
    logWithContext('info', 'Processing idea message', { 
      requestId, 
      userId: message.user, 
      messageLength: message.text.length 
    });
    
    // Get username with fallback
    let username = 'Anonymous';
    try {
      const userInfo = await client.users.info({ user: message.user });
      username = userInfo.user.display_name || userInfo.user.real_name || userInfo.user.name || 'Anonymous';
    } catch (error) {
      logWithContext('warn', 'Could not fetch user info, using fallback', { requestId, error: error.message });
    }
    
    // Categorize and save
    const category = categorizeIdea(message.text);
    
    const ideaId = await saveIdea(
      message.user,
      username,
      message.text,
      category.name,
      message.ts,
      message.channel,
      requestId
    );
    
    if (!ideaId) {
      throw new Error('Failed to save idea to database');
    }
    
    // Add reactions
    const randomReaction = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
    
    await Promise.all([
      client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: randomReaction
      }),
      client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: category.emoji
      })
    ]);
    
    logWithContext('info', 'Reactions added successfully', { requestId, ideaId });
    
    // Send response with delay for dramatic effect
    setTimeout(async () => {
      try {
        const randomResponse = FUNNY_RESPONSES[Math.floor(Math.random() * FUNNY_RESPONSES.length)];
        
        await client.chat.postMessage({
          channel: message.channel,
          text: randomResponse,
          thread_ts: message.ts
        });
        
        await saveReaction(ideaId, 'response', randomResponse, requestId);
        
        // Dad joke chance
        if (Math.random() < CONFIG.dadJokeChance) {
          setTimeout(async () => {
            try {
              const randomJoke = DAD_JOKES[Math.floor(Math.random() * DAD_JOKES.length)];
              await client.chat.postMessage({
                channel: message.channel,
                text: `Bonus dad joke: ${randomJoke}`,
                thread_ts: message.ts
              });
              
              await saveReaction(ideaId, 'dad_joke', randomJoke, requestId);
              logWithContext('info', 'Dad joke sent', { requestId, ideaId });
            } catch (error) {
              logWithContext('error', 'Dad joke failed', { requestId, error: error.message });
            }
          }, 2000);
        }
        
        logWithContext('info', 'Message processing completed successfully', { requestId, ideaId });
        
      } catch (error) {
        logWithContext('error', 'Response sending failed', { requestId, error: error.message });
      }
    }, Math.random() * 3000 + 1000);
    
  } catch (error) {
    logWithContext('error', 'Message processing failed', { 
      requestId, 
      userId: message.user,
      error: error.message,
      stack: error.stack
    });
  }
});

// Enhanced stats command with loading state
app.command('/hackathon-stats', async ({ command, ack, respond }) => {
  const requestId = generateRequestId();
  await ack();
  
  try {
    // Rate limiting
    if (isRateLimited(command.user_id)) {
      await respond({
        text: '⏳ Hold lige! Du spørger lidt for hurtigt. Prøv igen om lidt.',
        response_type: 'ephemeral'
      });
      return;
    }
    
    logWithContext('info', 'Stats command requested', { requestId, userId: command.user_id });
    
    const stats = await getIdeaStats(requestId);
    
    if (!stats) {
      await respond({
        text: '❌ Kunne ikke hente statistikker. Database fejl - kontakt admin.',
        response_type: 'ephemeral'
      });
      return;
    }
    
    const categoryText = stats.categories.length > 0 ? 
      stats.categories.map(cat => `${cat.category}: ${cat.count}`).join('\n') : 
      'Ingen kategorier endnu';
    
    const topUsersText = stats.topUsers.length > 0 ? 
      stats.topUsers.map((user, index) => `${index + 1}. ${user.username}: ${user.idea_count} idéer`).join('\n') :
      'Ingen brugere endnu';
    
    const statsMessage = `
🎯 *Hackathon Idé-Status*

📈 *Total idéer:* ${stats.total}

📊 *Kategorier:*
${categoryText}

🏆 *Top Idé-Generatorer:*
${topUsersText}

💪 *Status:* ${stats.total > 10 ? 'Vi er klar til at rocke hackathon! 🚀' : 'Vi har brug for flere idéer! Kom nu, folk! <!channel>'}

_Fortsæt med at dele idéer i #hackathon-ideas!_
    `;
    
    await respond({
      text: statsMessage,
      response_type: 'in_channel'
    });
    
    logWithContext('info', 'Stats command completed', { requestId, totalIdeas: stats.total });
    
  } catch (error) {
    logWithContext('error', 'Stats command failed', { requestId, error: error.message });
    await respond({
      text: '❌ Ups! Noget gik galt ved hentning af statistikker. Prøv igen om lidt! 🤖',
      response_type: 'ephemeral'
    });
  }
});

// Enhanced manual motivation trigger
app.command('/motivate-now', async ({ command, ack, respond }) => {
  const requestId = generateRequestId();
  await ack();
  
  try {
    if (command.user_id !== CONFIG.adminUserId) {
      await respond({
        text: '❌ Kun admin kan sende manuel motivationsbesked!',
        response_type: 'ephemeral'
      });
      return;
    }
    
    // Rate limiting even for admin
    if (isRateLimited(`admin_${command.user_id}`)) {
      await respond({
        text: '⏳ Vent lidt med at sende flere motivationsbeskeder.',
        response_type: 'ephemeral'
      });
      return;
    }
    
    logWithContext('info', 'Manual motivation triggered', { requestId, adminId: command.user_id });
    
    if (!process.env.HACKATHON_CHANNEL_ID) {
      await respond({
        text: '❌ HACKATHON_CHANNEL_ID ikke konfigureret!',
        response_type: 'ephemeral'
      });
      return;
    }
    
    const stats = await getIdeaStats(requestId);
    
    if (!stats || stats.total === 0) {
      await respond({
        text: '⚠️ Ingen idéer i database endnu - post nogle "Ide:" beskeder først!',
        response_type: 'ephemeral'
      });
      return;
    }
    
    const motivationMessage = generateMotivationalMessage(stats);
    
    await app.client.chat.postMessage({
      channel: process.env.HACKATHON_CHANNEL_ID,
      text: motivationMessage
    });
    
    await respond({
      text: `✅ **Manuel motivationsbesked sendt!**\n\n📊 Stats: ${stats.total} idéer\n🕐 Tid: ${new Date().toLocaleTimeString('da-DK', {timeZone: 'Europe/Copenhagen'})}\n🎯 Besked sendt til #hackathon-ideas`,
      response_type: 'ephemeral'
    });
    
    logWithContext('info', 'Manual motivation sent successfully', { requestId, totalIdeas: stats.total });
    
  } catch (error) {
    logWithContext('error', 'Manual motivation failed', { requestId, error: error.message });
    await respond({
      text: `❌ **Fejl ved afsendelse:**\n\n\`\`\`${error.message}\`\`\``,
      response_type: 'ephemeral'
    });
  }
});

// NEW: Toggle daily reminder command
app.command('/toggle-daily-reminder', async ({ command, ack, respond }) => {
  const requestId = generateRequestId();
  await ack();
  
  try {
    // Only admin can toggle
    if (command.user_id !== CONFIG.adminUserId) {
      await respond({
        text: '❌ Kun admin kan ændre daglige påmindelser!',
        response_type: 'ephemeral'
      });
      return;
    }
    
    logWithContext('info', 'Daily reminder toggle requested', { 
      requestId, 
      adminId: command.user_id 
    });
    
    // Get current status
    const currentStatus = await getDailyReminderStatus(requestId);
    const newStatus = !currentStatus;
    
    // Update status
    await setDailyReminderStatus(newStatus, requestId);
    
    const statusEmoji = newStatus ? '✅' : '❌';
    const statusText = newStatus ? 'AKTIVERET' : 'DEAKTIVERET';
    const nextAction = newStatus ? 
      'Næste påmindelse sendes i morgen kl. 09:00' : 
      'Ingen automatiske påmindelser sendes';
    
    const responseBlocks = {
      "blocks": [
        {
          "type": "header",
          "text": {
            "type": "plain_text",
            "text": "🔔 Daglige Påmindelser",
            "emoji": true
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `${statusEmoji} **Status: ${statusText}**\n\n📅 ${nextAction}\n\n_Brug \`/toggle-daily-reminder\` for at skifte igen_`
          }
        },
        {
          "type": "divider"
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*⚙️ Admin Info:*\n• Ændret af: <@${command.user_id}>\n• Tidspunkt: ${new Date().toLocaleString('da-DK', {timeZone: 'Europe/Copenhagen'})}\n• Kanal: ${process.env.HACKATHON_CHANNEL_ID ? `<#${process.env.HACKATHON_CHANNEL_ID}>` : 'Ikke konfigureret'}`
          }
        }
      ]
    };
    
    await respond({
      "response_type": "ephemeral",
      ...responseBlocks
    });
    
    // Log the change
    logWithContext('info', 'Daily reminder status toggled successfully', { 
      requestId,
      previousStatus: currentStatus,
      newStatus: newStatus,
      adminId: command.user_id
    });
    
    // Optional: Send notification to hackathon channel about the change
    if (process.env.HACKATHON_CHANNEL_ID && newStatus !== currentStatus) {
      const channelMessage = newStatus ? 
        '🔔 Daglige påmindelser er nu aktiveret! I får besked hver dag kl. 09:00 🌅' :
        '🔕 Daglige påmindelser er nu deaktiveret. Brug `/motivate-now` for manuel motivation 💪';
      
      try {
        await app.client.chat.postMessage({
          channel: process.env.HACKATHON_CHANNEL_ID,
          text: channelMessage
        });
      } catch (error) {
        logWithContext('warn', 'Could not send channel notification', { 
          requestId, 
          error: error.message 
        });
      }
    }
    
  } catch (error) {
    logWithContext('error', 'Daily reminder toggle failed', { 
      requestId, 
      error: error.message,
      stack: error.stack
    });
    
    await respond({
      text: `❌ **Fejl ved ændring af påmindelser:**\n\n\`\`\`${error.message}\`\`\`\n\nPrøv igen eller kontakt tech support.`,
      response_type: 'ephemeral'
    });
  }
});

// NEW: Check reminder status command
app.command('/reminder-status', async ({ command, ack, respond }) => {
  const requestId = generateRequestId();
  await ack();
  
  try {
    const currentStatus = await getDailyReminderStatus(requestId);
    const statusEmoji = currentStatus ? '✅' : '❌';
    const statusText = currentStatus ? 'AKTIVERET' : 'DEAKTIVERET';
    const nextAction = currentStatus ? 
      'Næste påmindelse: I morgen kl. 09:00' : 
      'Ingen automatiske påmindelser planlagt';
    
    const isAdmin = command.user_id === CONFIG.adminUserId;
    const adminInfo = isAdmin ? 
      '\n\n🔧 _Som admin kan du bruge `/toggle-daily-reminder` for at ændre status_' : 
      '';
    
    await respond({
      text: `🔔 **Daglige Påmindelser**\n\n${statusEmoji} Status: **${statusText}**\n📅 ${nextAction}${adminInfo}`,
      response_type: 'ephemeral'
    });
    
    logWithContext('info', 'Reminder status checked', { 
      requestId, 
      userId: command.user_id,
      currentStatus 
    });
    
  } catch (error) {
    logWithContext('error', 'Reminder status check failed', { 
      requestId, 
      error: error.message 
    });
    
    await respond({
      text: `❌ Kunne ikke hente påmindelse status: ${error.message}`,
      response_type: 'ephemeral'
    });
  }
});

// Help command for user guidance
app.command('/hackathon-help', async ({ command, ack, respond }) => {
  await ack();
  
  const helpMessage = `
🤖 **Forteil Hackathon Bot - Hjælp**

**📝 Sådan Poster Du en Idé:**
Start din besked med "Ide:" efterfulgt af din idé:
\`Ide: AI chatbot til HR-spørgsmål\`

**🎯 Bot Reaktioner:**
- 2 emoji reactions (random + kategori)
- Vittigt svar i thread
- 25% chance for bonus dad joke
- Automatisk kategorisering og database lagring

**📊 Available Commands:**
- \`/hackathon-stats\` - Se alle statistikker
- \`/hackathon-help\` - Denne hjælp besked
- \`/leaderboard\` - Live rangliste (alle kan se)
- \`/motivate-now\` - Admin: Send motivation nu
- \`/show-ideas\` - Admin: Visuelt overblik

**🔔 Reminder Commands:**
- \`/toggle-daily-reminder\` - Admin: Skru daglige påmindelser til/fra
- \`/reminder-status\` - Se status for daglige påmindelser

**🏷️ Kategorier:**
🤖 AI & Automatisering • 🔗 Integrationer • ⚙️ Procesoptimering
📊 Data & Visualisering • 🎨 UI/UX • 💡 Kreative Løsninger

**💡 Tips:**
- Vær specifik i dine idé-beskrivelser
- Byg videre på andres idéer
- Brug /hackathon-stats for at se fremgang
- Check /leaderboard for at se din ranking

**🚀 Ready to innovate? Start med "Ide:" og lad kreativiteten flyde!**