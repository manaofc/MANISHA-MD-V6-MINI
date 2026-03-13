module.exports = {
    SESSION_ID: process.env.SESSION_ID === undefined ? '${sessionId} ' : process.env.SESSION_ID,
};
