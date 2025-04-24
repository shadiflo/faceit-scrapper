// improved-faceit-scraper.js
const axios = require('axios');
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
require('dotenv').config(); // Load environment variables from .env file

// Configure these values (from .env file or directly)
const FACEIT_API_KEY = process.env.FACEIT_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const SHEET_NAME = 'BotAccounts';

// Base patterns to search for
const BASE_PATTERNS = [
  '---TAKE',
  '---hiELO',
  '---MyELO',
  '---ggELO',
  '---ELObst',
  '---ELOg0d',
  '---GOTIt',
  '---topELO',
  '---TakeIt',
  '---ELOizi',
  '---oELO',
  '---youELO',
  '---ELOOO',
  '---Up-ELO',
  '---TakeIt'
];

// Faceit API client
const faceitClient = axios.create({
  baseURL: 'https://open.faceit.com/data/v4',
  headers: {
    'Authorization': `Bearer ${FACEIT_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Track processed user IDs to avoid duplicates
const processedUserIds = new Set();
let currentSheet = SHEET_NAME;
let sheetIndex = 1;
let totalAccountsSaved = 0;
let batchBuffer = [];
const BATCH_SIZE = 100; // Smaller batch size for more frequent updates

// Initialize Google Sheets API with direct credentials
async function getGoogleSheetsClient() {
  // Create JWT client using the provided credentials
  const jwtClient = new JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  // Authenticate
  await jwtClient.authorize();

  // Return configured sheets client
  return google.sheets({ version: 'v4', auth: jwtClient });
}

// Search for users with a specific pattern + number
async function searchUsers(pattern, offset = 0, limit = 100) {
  try {
    const response = await faceitClient.get('/search/players', {
      params: {
        nickname: pattern,
        offset,
        limit
      }
    });

    return response.data;
  } catch (error) {
    console.error(`Error searching for pattern ${pattern}:`, error.message);
    return { items: [], start: 0, end: 0, from: 0, to: 0 };
  }
}

// Function to validate if a nickname matches our exact bot pattern format
function isValidBotNickname(nickname, basePattern) {
  // Check if nickname starts with our base pattern
  if (!nickname.startsWith(basePattern)) {
    return false;
  }

  // Valid format is basePattern + "_" + numbers
  const remainingPart = nickname.substring(basePattern.length);
  const validFormat = /^_\d+$/;

  return validFormat.test(remainingPart);
}

// Extract all valid bot accounts for a pattern and save them immediately
async function processValidBotsForPattern(sheetsClient, basePattern, numberRange) {
  const pattern = `${basePattern}_${numberRange}`;
  console.log(`Searching for pattern: ${pattern}`);

  let offset = 0;
  const limit = 100;
  let validBotsCount = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await searchUsers(pattern, offset, limit);

    if (result.items && result.items.length > 0) {
      // Filter the results to only include valid bot accounts
      const validResults = result.items.filter(user =>
        isValidBotNickname(user.nickname, basePattern)
      );

      // Process new valid accounts (not seen before)
      const newValidBots = validResults.filter(user => !processedUserIds.has(user.player_id))
        .map(user => ({
          userId: user.player_id,
          nickname: user.nickname
        }));

      // Add to processed set
      validResults.forEach(user => processedUserIds.add(user.player_id));

      // Add new bots to our batch buffer
      if (newValidBots.length > 0) {
        batchBuffer.push(...newValidBots);
        validBotsCount += newValidBots.length;

        // If we've hit our batch size, write to sheet
        if (batchBuffer.length >= BATCH_SIZE) {
          await writeBufferedAccountsToSheet(sheetsClient);
        }
      }

      offset += limit;

      // Check if we've reached the end
      hasMore = result.items.length === limit;

      // Add a delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 500));

      console.log(`Found ${validBotsCount} new valid bot accounts so far for pattern ${pattern}...`);
    } else {
      hasMore = false;
    }
  }

  return validBotsCount;
}

// Initialize or clear the spreadsheet
async function initializeSpreadsheet(sheetsClient) {
  try {
    // Check if the sheet exists
    await sheetsClient.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [SHEET_NAME]
    });

    // Clear existing content
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:B`
    });

    console.log(`Cleared existing content in sheet: ${SHEET_NAME}`);
  } catch (error) {
    console.log(`Sheet ${SHEET_NAME} doesn't exist, creating it...`);

    // Create the sheet if it doesn't exist
    try {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{
            addSheet: {
              properties: {
                title: SHEET_NAME
              }
            }
          }]
        }
      });
      console.log(`Created new sheet: ${SHEET_NAME}`);
    } catch (createError) {
      console.error(`Error creating sheet: ${createError.message}`);
      throw createError;
    }
  }

  // Add headers
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:B1`,
    valueInputOption: 'RAW',
    resource: {
      values: [['User ID', 'Nickname']]
    }
  });

  console.log('Added headers to the spreadsheet');
}

// Write the currently buffered accounts to the spreadsheet
async function writeBufferedAccountsToSheet(sheetsClient) {
  if (batchBuffer.length === 0) {
    return;
  }

  // Convert users to rows format
  const rows = batchBuffer.map(user => [
    user.userId,
    user.nickname
  ]);

  try {
    // Try to append the batch
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${currentSheet}!A:B`,
      valueInputOption: 'RAW',
      resource: {
        values: rows
      }
    });

    totalAccountsSaved += rows.length;
    console.log(`Added ${rows.length} accounts to ${currentSheet} (Total saved: ${totalAccountsSaved})`);

  } catch (error) {
    // If we hit a limit, create a new sheet and continue
    if (error.message.includes('exceeds the limit') ||
        error.message.includes('exceeds grid limits') ||
        error.message.includes('range') ||
        error.message.includes('limit')) {

      console.log(`Sheet ${currentSheet} reached a limit. Creating a new sheet...`);

      // Create a new sheet
      sheetIndex++;
      currentSheet = `${SHEET_NAME}_${sheetIndex}`;

      try {
        // Add the new sheet
        await sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          resource: {
            requests: [{
              addSheet: {
                properties: {
                  title: currentSheet
                }
              }
            }]
          }
        });

        // Add headers to new sheet
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${currentSheet}!A1:B1`,
          valueInputOption: 'RAW',
          resource: {
            values: [['User ID', 'Nickname']]
          }
        });

        console.log(`Created new sheet: ${currentSheet}`);

        // Try to write this batch to the new sheet
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${currentSheet}!A:B`,
          valueInputOption: 'RAW',
          resource: {
            values: rows
          }
        });

        totalAccountsSaved += rows.length;
        console.log(`Added ${rows.length} accounts to ${currentSheet} (Total saved: ${totalAccountsSaved})`);

      } catch (newSheetError) {
        console.error(`Error creating or writing to new sheet: ${newSheetError.message}`);
        throw newSheetError;
      }
    } else {
      // If it's a different error, throw it
      console.error(`Error writing batch to spreadsheet: ${error.message}`);
      throw error;
    }
  }

  // Clear the buffer after successful write
  batchBuffer = [];
}

// Main function
async function main() {
  try {
    console.log('Starting Faceit account scraper...');
    console.log(`Using Faceit API key: ${FACEIT_API_KEY.slice(0, 5)}...`);
    console.log(`Using spreadsheet ID: ${SPREADSHEET_ID}`);

    // Initialize Google Sheets
    console.log('Authenticating with Google...');
    const sheetsClient = await getGoogleSheetsClient();
    console.log('Google authentication successful');

    // Initialize spreadsheet
    await initializeSpreadsheet(sheetsClient);

    let totalAccountsFound = 0;

    // Search for each pattern with different number ranges
    for (const basePattern of BASE_PATTERNS) {
      console.log(`Processing base pattern: ${basePattern}`);

      // Define number ranges to search in batches
      const numberRanges = ['', '*']; // Empty string for general search, * as wildcard

      // Also add numeric ranges (searching in batches)
      for (let i = 1; i <= 400; i += 20) {
        const rangeEnd = Math.min(i + 19, 400);
        numberRanges.push(`${i}-${rangeEnd}`);
      }

      // Search for each pattern + number range combination
      for (const numberRange of numberRanges) {
        const validBotsCount = await processValidBotsForPattern(sheetsClient, basePattern, numberRange);

        if (validBotsCount > 0) {
          totalAccountsFound += validBotsCount;
          console.log(`Found ${validBotsCount} valid bot accounts for ${basePattern}_${numberRange}`);
        }

        // Add a delay between searches to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Flush any remaining accounts in the buffer
    if (batchBuffer.length > 0) {
      await writeBufferedAccountsToSheet(sheetsClient);
    }

    console.log(`Completed! Found and saved ${totalAccountsFound} unique bot accounts total.`);
    console.log(`Total accounts in spreadsheet: ${totalAccountsSaved}`);

  } catch (error) {
    console.error('Error in main process:', error);

    // Try to save any remaining accounts in the buffer
    try {
      if (batchBuffer.length > 0) {
        const sheetsClient = await getGoogleSheetsClient();
        await writeBufferedAccountsToSheet(sheetsClient);
        console.log('Saved remaining accounts before exit.');
      }
    } catch (finalSaveError) {
      console.error('Error in final save attempt:', finalSaveError);
    }
  }
}

// Run the main function
main().then(() => {
  console.log('Script execution finished.');
}).catch(error => {
  console.error('Unhandled error:', error);
});
