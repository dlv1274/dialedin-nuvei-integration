// server.js - Node.js Express Server for DialedIn-Nuvei Integration
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// Serve static files (payment form)
app.use(express.static('public'));

// Nuvei tokenization endpoint
app.post('/api/tokenize', async (req, res) => {
    try {
        const { paymentData, type, contactId } = req.body;
        
        console.log(`[INFO] Tokenization request for contact ${contactId}, type: ${type}`);
        
        // Validate input
        if (!paymentData || !type || !contactId) {
            return res.status(400).json({ 
                error: 'Missing required fields: paymentData, type, contactId' 
            });
        }
        
        // Generate Nuvei authentication
        const timestamp = Math.floor(Date.now() / 1000);
        const checksum = generateNuveiChecksum(timestamp);
        
        let nuveiPayload;
        
        if (type === 'card') {
            nuveiPayload = {
                merchantId: process.env.NUVEI_MERCHANT_ID,
                merchantSiteId: process.env.NUVEI_SITE_ID,
                timeStamp: timestamp,
                checksum: checksum,
                cardData: {
                    cardNumber: paymentData.cardNumber,
                    cardHolderName: paymentData.cardHolderName,
                    expirationMonth: paymentData.expirationMonth,
                    expirationYear: paymentData.expirationYear,
                    CVV: paymentData.CVV
                }
            };
        } else if (type === 'ach') {
            nuveiPayload = {
                merchantId: process.env.NUVEI_MERCHANT_ID,
                merchantSiteId: process.env.NUVEI_SITE_ID,
                timeStamp: timestamp,
                checksum: checksum,
                accountData: {
                    routingNumber: paymentData.routingNumber,
                    accountNumber: paymentData.accountNumber,
                    accountHolderName: paymentData.accountHolderName,
                    accountType: paymentData.accountType
                }
            };
        } else {
            return res.status(400).json({ error: 'Invalid payment type' });
        }
        
        // Call Nuvei tokenization API
        const nuveiEndpoint = process.env.NODE_ENV === 'production' 
            ? 'https://secure.nuvei.com/ppp/api/v1/tokenization'
            : 'https://ppptest.nuvei.com/ppp/api/v1/tokenization';
            
        console.log(`[INFO] Calling Nuvei API: ${nuveiEndpoint}`);
        
        const nuveiResponse = await axios.post(nuveiEndpoint, nuveiPayload, {
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (nuveiResponse.data.status === 'SUCCESS') {
            console.log(`[SUCCESS] Nuvei tokenization successful for contact ${contactId}`);
            
            // Prepare data for DialedIn
            const dialedInData = {
                PayGUID: nuveiResponse.data.token,
                PayType: type === 'card' ? 'Charge Card' : 'EFT',
                Last4: type === 'card' 
                    ? paymentData.cardNumber.slice(-4)
                    : paymentData.accountNumber.slice(-4),
                EXMO: type === 'card' ? paymentData.expirationMonth : '',
                EXYR: type === 'card' ? paymentData.expirationYear : ''
            };
            
            // Update DialedIn
            await updateDialedInContact(contactId, dialedInData);
            
            res.json({
                success: true,
                token: nuveiResponse.data.token,
                message: 'Payment method successfully tokenized'
            });
            
        } else {
            console.error(`[ERROR] Nuvei tokenization failed:`, nuveiResponse.data);
            res.status(400).json({
                error: 'Tokenization failed',
                details: nuveiResponse.data.reason || 'Unknown error'
            });
        }
        
    } catch (error) {
        console.error('[ERROR] Tokenization process failed:', error.message);
        
        if (error.response) {
            console.error('API Response:', error.response.data);
        }
        
        res.status(500).json({
            error: 'Internal server error during tokenization',
            message: error.message
        });
    }
});

// DialedIn update endpoint
async function updateDialedInContact(contactId, tokenData) {
    try {
        const params = new URLSearchParams({
            token: process.env.DIALEDIN_TOKEN,
            accid: process.env.DIALEDIN_ACCID,
            SearchField: 'LeadId',
            Identifier: contactId,
            'adv_PayGUID': tokenData.PayGUID,
            'adv_PayType': tokenData.PayType,
            'adv_Last4': tokenData.Last4,
            'adv_EXMO': tokenData.EXMO,
            'adv_EXYR': tokenData.EXYR
        });

        console.log(`[INFO] Updating DialedIn contact ${contactId}`);
        
        const response = await axios.get(
            `https://api.chasedatacorp.com/HttpImport/UpdateLead.php?${params.toString()}`,
            { timeout: 15000 }
        );
        
        console.log(`[SUCCESS] DialedIn update successful for contact ${contactId}`);
        return response.data;
        
    } catch (error) {
        console.error(`[ERROR] DialedIn update failed for contact ${contactId}:`, error.message);
        
        // Log failed update for manual processing
        await logFailedUpdate(contactId, tokenData, error.message);
        throw error;
    }
}

// Generate Nuvei checksum for authentication
function generateNuveiChecksum(timestamp) {
    const string = process.env.NUVEI_MERCHANT_ID + 
                  process.env.NUVEI_SITE_ID + 
                  timestamp + 
                  process.env.NUVEI_SECRET_KEY;
    return crypto.createHash('sha256').update(string).digest('hex');
}

// Log failed updates for manual processing
async function logFailedUpdate(contactId, tokenData, errorMessage) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        contactId: contactId,
        tokenData: tokenData,
        error: errorMessage
    };
    
    // In production, this would write to a database or log file
    console.error('[FAILED_UPDATE_LOG]', JSON.stringify(logEntry));
    
    // Could also send to monitoring service, email alert, etc.
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0'
    });
});

// Test endpoint for validating configuration
app.get('/api/test-config', (req, res) => {
    const requiredEnvVars = [
        'NUVEI_MERCHANT_ID',
        'NUVEI_SITE_ID',
        'NUVEI_SECRET_KEY',
        'DIALEDIN_TOKEN',
        'DIALEDIN_ACCID'
    ];
    
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
        return res.status(500).json({
            error: 'Missing required environment variables',
            missing: missingVars
        });
    }
    
    res.json({
        status: 'Configuration valid',
        environment: process.env.NODE_ENV || 'development',
        merchantId: process.env.NUVEI_MERCHANT_ID,
        dialedInAccId: process.env.DIALEDIN_ACCID
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('[GLOBAL_ERROR]', error);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.originalUrl
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`[INFO] Server running on port ${PORT}`);
    console.log(`[INFO] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[INFO] Health check: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[INFO] SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[INFO] SIGINT received, shutting down gracefully');
    process.exit(0);
});

module.exports = app;
