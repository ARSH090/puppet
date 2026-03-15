const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FB_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

// Initialize Supabase
let supabase;
if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
    console.warn("⚠️ Warning: Supabase credentials not found in environment.");
}

// Track active sessions to limit concurrency on Render
let activeSessionsCount = 0;
const MAX_CONCURRENT_SESSIONS = 3;

// Clean up old sessions periodically
setInterval(async () => {
    if (!supabase) return;
    try {
        const thirtyMinsAgo = new Date(Date.now() - 30 * 60000).toISOString();
        const { error } = await supabase
            .from('otp_sessions')
            .delete()
            .lt('created_at', thirtyMinsAgo);
        if (error) console.error("Session cleanup error:", error);
    } catch (e) { /* ignore */ }
}, 5 * 60000); // every 5 mins

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

async function sendFBMessage(messengerId, text) {
    if (!FB_TOKEN) {
        console.error("No FB token available to send message:", text);
        return;
    }
    try {
        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${FB_TOKEN}`, {
            recipient: { id: messengerId },
            message: { text }
        });
    } catch (e) {
        console.error("FB Send Error:", e.response?.data || e.message);
    }
}

async function logActivity(messengerId, step, status, message) {
    if (!supabase) return;
    try {
        await supabase.from('automation_logs').insert({
            lead_messenger_id: messengerId,
            step,
            status,
            message: message.substring(0, 500) // truncate long messages
        });
    } catch (e) {
        console.error("Log error:", e.message);
    }
}

async function updateLead(messengerId, data) {
    if (!supabase) return;
    try {
        await supabase.from('leads').update({
            ...data,
            updated_at: new Date().toISOString()
        }).eq('messenger_id', messengerId);
    } catch (e) {
        console.error("Update Lead error:", e.message);
    }
}

async function uploadScreenshot(base64Data, sessionId) {
    if (!supabase) return "No screenshot (Supabase not configured)";
    try {
        // Convert base64 to buffer
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = `${sessionId}.png`;

        const { data, error } = await supabase.storage
            .from('screenshots')
            .upload(filename, buffer, {
                contentType: 'image/png',
                upsert: true
            });

        if (error) throw error;

        const { data: publicData } = supabase.storage
            .from('screenshots')
            .getPublicUrl(filename);

        return publicData.publicUrl;
    } catch (e) {
        console.error("Screenshot upload error:", e.message);
        return "Screenshot failed to upload";
    }
}

async function waitForOTP(messengerId, round, timeoutMinutes = 5) {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        if (!supabase) return null; // Can't check DB

        try {
            const { data, error } = await supabase
                .from('otp_sessions')
                .select('otp_value')
                .eq('messenger_id', messengerId)
                .eq('otp_round', round)
                .eq('submitted', false)
                .order('created_at', { ascending: false })
                .limit(1);

            if (!error && data && data.length > 0 && data[0].otp_value) {
                // Mark as submitted so we don't read it again
                await supabase.from('otp_sessions')
                    .update({ submitted: true })
                    .eq('messenger_id', messengerId)
                    .eq('otp_round', round);

                return data[0].otp_value;
            }
        } catch (e) {
            console.error("OTP poll error:", e.message);
        }

        // Wait 10 seconds before next poll
        await new Promise(r => setTimeout(r, 10000));
    }
    return null; // timeout
}

async function typeDigitByDigit(page, selector, text) {
    for (let i = 0; i < text.length; i++) {
        await page.type(selector, text[i], { delay: 80 + Math.random() * 40 });
    }
}

function findChromeBinary() {
    const { execSync } = require('child_process');
    
    // Try environment variable first
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        console.log('Using PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    // Try all known paths
    const paths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/opt/google/chrome/chrome',
        '/opt/google/chrome/google-chrome',
        '/usr/local/bin/chromium',
        '/usr/local/bin/google-chrome',
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) {
            console.log('Chrome found at:', p);
            return p;
        }
    }

    // Try which command
    try {
        const result = execSync(
            'which google-chrome-stable || which google-chrome || which chromium-browser || which chromium',
            { encoding: 'utf8' }
        ).trim().split('\n')[0];
        if (result && fs.existsSync(result)) {
            console.log('Chrome found via which:', result);
            return result;
        }
    } catch(e) {}

    // Last resort - find command
    try {
        const result = execSync(
            'find /usr /opt -name "google-chrome-stable" -o -name "google-chrome" -o -name "chromium" 2>/dev/null | head -1',
            { encoding: 'utf8' }
        ).trim();
        if (result && fs.existsSync(result)) {
            console.log('Chrome found via find:', result);
            return result;
        }
    } catch(e) {}

    return null;
}

// -----------------------------------------------------------------------------
// AUTOMATION LOGIC
// -----------------------------------------------------------------------------

async function runAutomationFlow(params) {
    const { messengerId, mobile, name, dob, pan, aadhaar, sessionId } = params;

    let browser = null;
    let fallbackToken = FB_TOKEN; // In case we fetch a different one
    let targetUrl = "https://trackloom.com/464314?a=UN11887";
    let vendor = "Rishi";
    let emailFallback = "k";
    let adminId = null;

    try {
        // 1. Fetch runtime config
        if (supabase) {
            const { data: settings } = await supabase.from('bot_settings').select('key, value');
            if (settings) {
                const getSetting = (k) => settings.find(s => s.key === k)?.value;
                if (getSetting('trackloom_url')) targetUrl = getSetting('trackloom_url');
                if (getSetting('vendor_name')) vendor = getSetting('vendor_name');
                if (getSetting('email_field_value')) emailFallback = getSetting('email_field_value');
                adminId = getSetting('admin_messenger_id');
                const dbFBToken = getSetting('fb_page_access_token');
                if (dbFBToken) fallbackToken = dbFBToken; // override with DB token if exists
            }
        }

        // Re-map token for sendFBMessage if we fetched it purely from DB
        process.env.FB_PAGE_ACCESS_TOKEN = fallbackToken;

        await logActivity(messengerId, 'START', 'success', 'Automation started');
        await updateLead(messengerId, { status: 'processing', process_state: 'automation_started' });

        // Launch Browser
        browser = await puppeteer.launch({
            headless: 'new', // use new headless mode
            executablePath: findChromeBinary(),
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844 });
        // Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1');

        // ==== TRACKLOOM ====
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for inputs. Assuming standard form order: Name, Mobile, Email, Vendor
        await page.waitForSelector('input', { timeout: 30000 });
        const inputs = await page.$$('input');

        if (inputs.length >= 4) {
            await inputs[0].type(name || 'Customer');
            await inputs[1].type(mobile);
            await inputs[2].type(emailFallback);
            await inputs[3].type(vendor);
        } else {
            throw new Error("Trackloom form inputs not found.");
        }

        // Find submit/continue button and click
        const buttons = await page.$$('button');
        let clicked = false;
        for (const btn of buttons) {
            const text = await page.evaluate(el => el.textContent.toLowerCase(), btn);
            if (text.includes('submit') || text.includes('continue') || text.includes('next')) {
                await btn.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) throw new Error("Could not find Trackloom submit button");

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log("Navigation timeout ok"));
        await logActivity(messengerId, 'TRACKLOOM', 'success', 'Submitted Trackloom');

        // ==== BAJAJ MOBILE ENTER ====
        // At this point we should be on Bajaj Finserv page
        
        // Handle potential Popups/Overlays
        try {
            await page.waitForSelector('.modal-close, .popup-close, #onetrust-accept-btn-handler', { timeout: 3000 });
            await page.click('.modal-close, .popup-close, #onetrust-accept-btn-handler');
        } catch (_) { }

        const telInputSelector = 'input[type="tel"]';
        // Give it some time to load the React app
        try {
            await page.waitForSelector(telInputSelector, { timeout: 30000 });
        } catch (e) {
            await page.screenshot({ path: 'debug.png', fullPage: true });
            console.log('Page HTML at failure:', await page.content());
            throw e;
        }

        await page.click(telInputSelector, { clickCount: 3 });
        await page.keyboard.press('Backspace');

        // --- THE BACKSPACE TRICK ---
        await typeDigitByDigit(page, telInputSelector, mobile);
        // Backspace once
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 600));
        // Type last digit again
        await page.type(telInputSelector, mobile.slice(-1));
        await new Promise(r => setTimeout(r, 1200));

        // Accept Terms Checkbox if visible
        try {
            const checkbox = await page.$('input[type="checkbox"]');
            if (checkbox) await checkbox.click();
        } catch (e) { } // ignore if not found

        // Click Get OTP
        const getOtpBtns = await page.$$('button');
        clicked = false;
        for (const btn of getOtpBtns) {
            const text = await page.evaluate(el => el.textContent.toLowerCase(), btn);
            if (text.includes('otp')) {
                await btn.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) throw new Error("Could not find GET OTP button");

        await new Promise(r => setTimeout(r, 2000));
        await logActivity(messengerId, 'OTP1', 'success', 'OTP 1 Requested');

        // ==== ASK LEAD FOR OTP 1 ====
        await sendFBMessage(messengerId, "Otp dizea 🔢");
        await updateLead(messengerId, { process_state: 'collecting_otp1' });

        const otp1 = await waitForOTP(messengerId, 1, 5);
        if (!otp1) {
            await sendFBMessage(messengerId, "OTP time out ho gaya, dobara try karein jab aap free ho.");
            await updateLead(messengerId, { status: 'failed', process_state: 'otp1_timeout' });
            throw new Error("OTP 1 Timeout");
        }

        // ==== SUBMIT OTP 1 ====
        // Usually 6 boxes
        await page.waitForSelector('input[maxlength="1"]', { timeout: 30000 });
        const otpInputs = await page.$$('input[maxlength="1"]');

        // Make sure we type strictly up to the available boxes (max 6)
        for (let i = 0; i < Math.min(otpInputs.length, otp1.length); i++) {
            await otpInputs[i].type(otp1[i]);
            await new Promise(r => setTimeout(r, 100)); // Slight delay between boxes
        }

        const submitBtns = await page.$$('button');
        for (const btn of submitBtns) {
            const text = await page.evaluate(el => el.textContent.toLowerCase(), btn);
            if (text.includes('submit') || text.includes('verify')) {
                await btn.click();
                break;
            }
        }

        await new Promise(r => setTimeout(r, 5000)); // wait for result
        await logActivity(messengerId, 'OTP1_SUBMIT', 'success', 'OTP 1 Submitted');

        // ==== DETECT PAGE CONTENT ====
        // Connection Timeout retry logic
        for (let retry = 0; retry < 3; retry++) {
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (bodyText.includes('Connection timeout') || bodyText.includes('Something went wrong')) {
                const retryBtn = await page.$('button'); // find retry button roughly
                if (retryBtn && (await page.evaluate(el => el.textContent.toLowerCase(), retryBtn)).includes('retry')) {
                    await retryBtn.click();
                    await new Promise(r => setTimeout(r, 10000));
                }
            } else {
                break;
            }
            if (retry === 2) {
                await sendFBMessage(messengerId, "Server problem aa rahi hai try later.");
                await updateLead(messengerId, { status: 'failed', process_state: 'server_timeout' });
                throw new Error("Server Timeout after 3 retries");
            }
        }

        const finalContent = await page.evaluate(() => document.body.innerText);

        if (finalContent.includes('already have the Insta EMI') || finalContent.includes('already exists')) {
            await sendFBMessage(messengerId, "Aapka card already hai sir");
            await updateLead(messengerId, { status: 'existing_card', process_state: 'completed' });
            throw new Error("User already has card (controlled halt)");
        }

        const isApproved =
            finalContent.includes('Congratulations') ||
            finalContent.includes('55,000') ||
            finalContent.includes('80,000') ||
            finalContent.includes('loan offer');

        if (!isApproved) {
            await sendFBMessage(messengerId, "Ni ho skta aapka cibil score achha ni hai aapko kisi or ke documents se Krna prega");
            await updateLead(messengerId, { status: 'failed', process_state: 'cibil_rejected' });
            await logActivity(messengerId, 'CHECK_ELIGIBILITY', 'failed', 'CIBIL Rejected');
            throw new Error("CIBIL Rejected (controlled halt)");
        }

        // Extract amount roughly
        const match = finalContent.match(/₹[\d,]+/);
        const amount = match ? match[0] : "Approval";

        await sendFBMessage(messengerId, `Congratulations! ${amount} ka offer aaya`);
        await logActivity(messengerId, 'CHECK_ELIGIBILITY', 'success', 'Approved');

        // ==== WALLET SETUP ====
        await new Promise(r => setTimeout(r, 2000));

        // PEP Checkboxes
        const checkboxes = await page.$$('input[type="checkbox"]');
        for (const cb of checkboxes) {
            const isChecked = await page.evaluate(el => el.checked, cb);
            if (!isChecked) {
                // We use evaluate to click sometimes as Puppeteer click on hidden custom checkboxes can fail
                await page.evaluate(el => el.click(), cb).catch(() => { });
            }
        }

        // Click Get OTP 2
        const getOtp2Btns = await page.$$('button');
        clicked = false;
        for (const btn of getOtp2Btns) {
            const text = await page.evaluate(el => el.textContent.toLowerCase(), btn);
            if (text.includes('otp')) {
                await btn.click();
                clicked = true;
                break;
            }
        }
        // Proceed even if we didn't explicitly find the btn, the UI might have auto-triggered

        await new Promise(r => setTimeout(r, 2000));
        await logActivity(messengerId, 'OTP2', 'success', 'Wallet OTP Requested');

        await sendFBMessage(messengerId, "Ek last otp dizea");
        await updateLead(messengerId, { process_state: 'collecting_otp2' });

        const otp2 = await waitForOTP(messengerId, 2, 5);
        if (!otp2) {
            await sendFBMessage(messengerId, "OTP time out ho gaya.");
            await updateLead(messengerId, { status: 'failed', process_state: 'otp2_timeout' });
            throw new Error("OTP 2 Timeout");
        }

        // Submit OTP 2
        // Assuming the same 6 inputs might have remounted, refetch them
        await page.waitForSelector('input[maxlength="1"]', { timeout: 30000 });
        const otp2Inputs = await page.$$('input[maxlength="1"]');
        for (let i = 0; i < Math.min(otp2Inputs.length, otp2.length); i++) {
            await otp2Inputs[i].type(otp2[i]);
            await new Promise(r => setTimeout(r, 100));
        }

        const submit2Btns = await page.$$('button');
        for (const btn of submit2Btns) {
            const text = await page.evaluate(el => el.textContent.toLowerCase(), btn);
            if (text.includes('submit') || text.includes('verify')) {
                await btn.click();
                break;
            }
        }

        await new Promise(r => setTimeout(r, 5000));
        await logActivity(messengerId, 'OTP2_SUBMIT', 'success', 'Wallet OTP Submitted');

        // ==== COMPLETED ====
        const screenshotBase64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
        const screenshotUrl = await uploadScreenshot(screenshotBase64, sessionId);

        await updateLead(messengerId, { status: 'completed', process_state: 'automation_completed' });
        await sendFBMessage(messengerId, "Ho gaya Aapka process complete hua");

        if (adminId) {
            const adminReport = `KYC DONE\nName: ${name || 'N/A'}\nMobile: ${mobile}\nAmount: ${amount}\nWallet: Done\nScreenshot: ${screenshotUrl}`;
            await sendFBMessage(adminId, adminReport);
        }

        await logActivity(messengerId, 'COMPLETED', 'success', 'Automation completed fully');

    } catch (error) {
        // Only mark as general error if we didn't throw a controlled halt
        if (!error.message.includes('controlled halt') && !error.message.includes('Timeout')) {
            console.error("Automation error:", error);
            await logActivity(messengerId, 'ERROR', 'failed', error.message || 'Unknown error');
            await updateLead(messengerId, { status: 'failed' });
            await sendFBMessage(messengerId, "Kuch problem aa gayi, admin ko bata diya. Mafi chahte hai.");
        }
    } finally {
        if (browser) {
            await browser.close().catch(() => { });
        }
        activeSessionsCount--;
    }
}

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------

app.get('/health', (req, res) => {
    let scanResult = '';
    try {
        scanResult = execSync(
            'find /usr /opt /bin -name "google-chrome*" -o -name "chromium*" 2>/dev/null | head -10',
            { encoding: 'utf8' }
        ).trim();
    } catch(e) { scanResult = 'scan failed: ' + e.message; }

    const chromePath = findChromeBinary();
    res.json({
        status: 'ok',
        chromeFound: !!chromePath,
        chromePath: chromePath || 'not found',
        chromeScan: scanResult,
        activeSessions: activeSessionsCount,
        time: new Date().toISOString()
    });
});

app.post('/automate/start', (req, res) => {
    const { messengerId, mobile, name, dob, pan, aadhaar, sessionId } = req.body;

    if (!messengerId || !mobile) {
        return res.status(400).json({ error: "missing required fields (messengerId, mobile)" });
    }

    // Quick limit check 
    if (activeSessionsCount >= MAX_CONCURRENT_SESSIONS) {
        return res.status(503).json({ error: "Service busy, too many active sessions on this node." });
    }

    activeSessionsCount++;

    // Return early, run automation async
    res.status(202).json({ success: true, message: "Automation started in background" });

    // Fire and forget
    runAutomationFlow({ messengerId, mobile, name, dob, pan, aadhaar, sessionId }).catch(e => {
        console.error("Critical async flow error:", e);
    });
});

app.post('/otp/submit', async (req, res) => {
    const { messengerId, otpValue, round } = req.body;

    if (!messengerId || !otpValue) {
        return res.status(400).json({ error: "Missing fields" });
    }

    if (!supabase) {
        return res.status(500).json({ error: "Database not connected" });
    }

    try {
        const { error } = await supabase.from('otp_sessions').insert({
            messenger_id: messengerId,
            otp_round: round || 1,
            otp_value: otpValue,
            submitted: false,
            // expires_at is handled by default NOW() + 5 min in DB schema
        });

        if (error) throw error;

        res.json({ success: true });
    } catch (e) {
        console.error("OTP Receive error:", e.message);
        res.status(500).json({ error: "System Error" });
    }
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
    try {
        const paths = execSync(
            'find /usr /opt /home -name "chrome" -o -name "chromium" -o -name "google-chrome" -o -name "google-chrome-stable" 2>/dev/null | head -10',
            { encoding: 'utf8' }
        ).trim();
        console.log('Chrome scan result:', paths);
    } catch(e) {
        console.log('Chrome scan failed:', e.message);
    }

    console.log(`🤖 Bajaj Puppeteer Service running on port ${PORT}`);
    if (!process.env.SUPABASE_URL) {
        console.log("⚠️ WARNING: SUPABASE_URL not set.");
    }
});
