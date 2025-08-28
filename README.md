# ShipStation Customs Updater

Updates customs information for pre-orders in ShipStation.

## Setup
1. Copy `.env.example` to `.env`
2. Add your ShipStation API credentials
3. Run `npm install`
4. Test with `npm run test-update`

## Endpoints
- GET `/test` - Updates 5 orders (safe testing)
- POST `/update` - Updates all orders (requires confirmation)
