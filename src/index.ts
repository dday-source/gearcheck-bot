import { Client, GatewayIntentBits, Partials, Message, AttachmentBuilder, EmbedBuilder, TextChannel } from 'discord.js';
import puppeteer, { Browser } from 'puppeteer';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

// Create the bot client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Reaction]
});

// Global browser instance
let browser: Browser | null = null;

// Track who's currently being processed
const processing = new Set<string>();

// When bot is ready
client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user?.tag}`);
  console.log(`📍 Monitoring channel: ${process.env.GEARCHECK_CHANNEL_ID}`);
});

// Listen for messages
client.on('messageCreate', async (message: Message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Check if message is in gear check channel
  if (message.channel.id !== process.env.GEARCHECK_CHANNEL_ID) return;

  // Get character name from message
  const characterName = message.content.trim();

  // Validate character name (letters only)
  if (!/^[a-zA-Z]+$/.test(characterName)) {
    await message.reply('❌ Please enter only your character name (letters only)');
    return;
  }

  // Check if already processing this user
  if (processing.has(message.author.id)) {
    await message.reply('⏳ Still processing your previous request...');
    return;
  }

  // Add to processing
  processing.add(message.author.id);

  try {
    // Add loading reaction
    await message.react('⏳');

    // Initialize browser if needed
    if (!browser) {
      console.log('🚀 Launching browser...');
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }

    // URLs for both sites
    const wclUrl = `https://fresh.warcraftlogs.com/character/us/nightslayer/${characterName.toLowerCase()}`;
    const armoryUrl = `https://classic-armory.org/character/us/classic/nightslayer/${characterName.toLowerCase()}`;

    console.log(`🔍 Checking character: ${characterName}`);

    // Take screenshots and get performance
    const [wclScreenshot, armoryScreenshot, perfAvg] = await Promise.all([
      takeScreenshot(browser, wclUrl, 'wcl'),
      takeScreenshot(browser, armoryUrl, 'armory'),
      getPerformanceAverage(browser, wclUrl)
    ]);

    // Remove loading reaction
    await message.reactions.removeAll();
    await message.react('✅');

    // Create response embed
    const embed = new EmbedBuilder()
      .setColor(perfAvg >= 70 ? 0xFFD700 : 0xFF0000)
      .setTitle(`Gear Check: ${characterName}`)
      .setDescription(`Verification requested by ${message.author}`)
      .addFields(
        {
          name: '📊 Best Performance Average',
          value: perfAvg > 0 ? `**${perfAvg.toFixed(1)}**` : 'Not Found',
          inline: true
        },
        {
          name: '✅ Status',
          value: perfAvg >= 70 ? 'Qualified for Stained' : 'Below 70 threshold',
          inline: true
        }
      )
      .setTimestamp();

    // Prepare attachments
    const files = [];
    if (wclScreenshot) files.push(new AttachmentBuilder(wclScreenshot, { name: 'warcraftlogs.png' }));
    if (armoryScreenshot) files.push(new AttachmentBuilder(armoryScreenshot, { name: 'armory.png' }));

    // Send response
    if (message.channel instanceof TextChannel) {
      await message.channel.send({
        embeds: [embed],
        files: files
      });
    }

    // Assign role if qualified
    if (perfAvg >= 70 && message.member) {
      try {
        await message.member.roles.add(process.env.STAINED_ROLE_ID!);
        if (message.channel instanceof TextChannel) {
          await message.channel.send(`✅ ${message.author} has been granted the **Stained** role!`);
        }
      } catch (error) {
        console.error('Failed to assign role:', error);
      }
    }

  } catch (error) {
    console.error('Error processing request:', error);
    await message.reactions.removeAll();
    await message.react('❌');
    await message.reply('❌ Failed to verify character. Character may not exist or sites may be down.');
  } finally {
    // Remove from processing
    processing.delete(message.author.id);
  }
});

// Screenshot function
async function takeScreenshot(browser: Browser, url: string, type: string): Promise<Buffer | null> {
  const page = await browser.newPage();
  
  try {
    console.log(`📸 Taking ${type} screenshot...`);
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Go to page
    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });

    // Wait a bit for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Take screenshot
    const screenshot = await page.screenshot({ 
      type: 'png',
      fullPage: false 
    });

    return screenshot as Buffer;

  } catch (error) {
    console.error(`Screenshot error for ${type}:`, error);
    return null;
  } finally {
    await page.close();
  }
}

// Get performance average function
async function getPerformanceAverage(browser: Browser, url: string): Promise<number> {
  const page = await browser.newPage();
  
  try {
    console.log('📊 Fetching performance average...');
    
    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });

    // Wait for content
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get page content
    const content = await page.content();
    
    // Look for performance average in the HTML
    // This regex looks for patterns like "94.9" or "100.0" near "Best Perf" text
    const perfMatch = content.match(/(?:Best Perf[\s\S]{0,100}?)(\d{1,3}\.\d{1})/i);
    
    if (perfMatch && perfMatch[1]) {
      const perfAvg = parseFloat(perfMatch[1]);
      console.log(`✅ Found performance average: ${perfAvg}`);
      return perfAvg;
    }

    // Try alternate patterns
    const altMatch = content.match(/(?:performance|perf)[\s\S]{0,50}?(\d{1,3}\.\d{1})/i);
    if (altMatch && altMatch[1]) {
      const perfAvg = parseFloat(altMatch[1]);
      console.log(`✅ Found performance average (alt): ${perfAvg}`);
      return perfAvg;
    }

    console.log('❌ Could not find performance average');
    return 0;

  } catch (error) {
    console.error('Error getting performance:', error);
    return 0;
  } finally {
    await page.close();
  }
}

// Error handling
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

// Login bot
client.login(process.env.BOT_TOKEN);
