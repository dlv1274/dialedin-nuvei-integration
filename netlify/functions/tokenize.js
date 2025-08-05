const axios = require('axios');
const crypto = require('crypto');

exports.handler = async (event, context) => {
    // Handle CORS preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { paymentData, type, contactId } = JSON.parse(event.body);
        
        console.log(`[INFO] TEST MODE - Tokenization request for contact ${contactId}, type: ${type}`);
        
        // Validate input
        if (!paymentData || !type || !contactId) {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    error: 'Missing required fields: paymentData, type, contactId' 
                })
            };
        }

        // Check if we have Site ID, if not use test mode
        const hasNuveiConfig = process.env.NUVEI_MERCHANT_ID && 
                              process.env.NUVEI_SITE_ID && 
                              process.env.NUVEI_SECRET_KEY;

        let tokenResponse;

        if (hasNuveiConfig) {
            // Real Nuvei API call
            console.log('[INFO] Using real Nuvei API');
            tokenResponse = await callNuveiAPI(paymentData, type);
        } else {
            // Mock response for testing
            console.log('[INFO] Using mock Nuvei response (missing Site ID)');
            tokenResponse = generateMockToken(paymentData, type);
        }

        if (tokenResponse.success) {
            console.log(`[SUCCESS] Tokenization successful for contact ${contactId}`);
            
            // Prepare data for DialedIn
            const dialedInData = {
                PayGUID: tokenResponse.token,
                PayType: type === 'card' ? 'Charge Card' : 'EFT',
                Last4: type === 'card' 
                    ? paymentData.cardNumber.slice(-4)
                    : paymentData.accountNumber.slice(-4),
                EXMO: type === 'card' ? paymentData.expirationMonth : '',
                EXYR: type === 'card' ? paymentData.expirationYear : ''
            };
            
            // Update DialedIn (this will work regardless)
            try {
                await updateDialedInContact(contactId, dialedInData);
            } catch (dialedInError) {
                console.log('[WARNING] DialedIn update failed, but tokenization succeeded');
            }
            
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    success: true,
                    token: tokenResponse.token,
                    message: tokenResponse.message,
                    testMode: !hasNuveiConfig
                })
            };
            
        } else {
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    error: 'Tokenization failed',
                    details: tokenResponse.error
                })
            };
        }
        
    } catch (error) {
        console.error('[ERROR] Tokenization process failed:', error.message);
        
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                error: 'Internal server error during tokenization',
                message: error.message
            })
        };
    }
};

// Real Nuvei API call
async function callNuveiAPI(paymentData, type) {
    try {
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
        }
        
        const nuveiEndpoint = process.env.NODE_ENV === 'production' 
            ? 'https://secure.nuvei.com/ppp/api/v1/tokenization'
            : 'https://ppptest.nuvei.com/ppp/api/v1/tokenization';
            
        const nuveiResponse = await axios.post(nuveiEndpoint, nuveiPayload, {
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (nuveiResponse.data.status === 'SUCCESS') {
            return {
                success: true,
                token: nuveiResponse.data.token,
                message: 'Payment method successfully tokenized via Nuvei API'
            };
        } else {
            return {
                success: false,
                error: nuveiResponse.data.reason || 'Unknown Nuvei error'
            };
        }
        
    } catch (error) {
        return {
            success: false,
            error: `Nuvei API error: ${error.message}`
        };
    }
}

// Mock token generation for testing
function generateMockToken(paymentData, type) {
    // Generate a realistic-looking test token
    const prefix = type === 'card' ? 'card_tok_' : 'ach_tok_';
    const randomId = Math.random().toString(36).substring(2, 15);
    const timestamp = Date.now().toString(36);
    
    return {
        success: true,
        token: `${prefix}${randomId}_${timestamp}`,
        message: 'TEST MODE: Mock token generated (awaiting Nuvei Site ID)'
    };
}

// DialedIn update function
async function updateDialedInContact(contactId, tokenData) {
    try {
        // Check if we have DialedIn credentials
        if (!process.env.DIALEDIN_TOKEN || !process.env.DIALEDIN_ACCID) {
            console.log('[WARNING] Missing DialedIn credentials, skipping update');
            return { status: 'skipped', reason: 'Missing DialedIn credentials' };
        }

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
