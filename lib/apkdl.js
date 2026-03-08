const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const cheerio = require('cheerio');
const tools = require('./apksearch'); // ඔයාගේ API helper

// file_size_url dependency එක නැතුව file size ගන්න function එක
async function getFileSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const size = res.headers.get('content-length');
    return size ? parseInt(size) : null;
  } catch (err) {
    console.error('Error getting file size:', err);
    return null;
  }
}

// Search function
async function search(query) {
  const res = await fetch(tools.api(5, '/apps/search', {
    query: query,
    limit: 1000
  }));

  const data = await res.json();
  const results = data.datalist.list.map(v => ({
    name: v.name,
    id: v.package
  }));

  return results;
}

// Download function
async function download(id) {
  const res = await fetch(tools.api(5, '/apps/search', {
    query: id,
    limit: 1
  }));

  const data = await res.json();
  const app = data.datalist.list[0];

  const name = app.name;
  const packageName = app.package;
  const icon = app.icon;
  const dllink = app.file.path;
  const lastup = app.updated;
  const size = await getFileSize(dllink);

  return {
    name,
    lastup,
    package: packageName,
    size,
    icon,
    dllink
  };
}

module.exports = { search, download };
