// Session configuration

const session = require('express-session');

const sessionMiddleware = session({
  name: 'hno.sid',
  secret: process.env.SESSION_SECRET || 'hemlock-oak-secret-2024',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24*60*60*1000
  }
});

module.exports = sessionMiddleware;
