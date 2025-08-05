curl -X POST https://didnuv.netlify.app/.netlify/functions/tokenize \
  -H "Content-Type: application/json" \
  -d '{
    "paymentData": {"cardNumber": "4000000000000002", "cardHolderName": "Test User", "expirationMonth": "12", "expirationYear": "25", "CVV": "123"},
    "type": "card",
    "contactId": "TEST123"
  }'
