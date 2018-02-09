/**
 * Copyright 2018 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import fs from 'fs';
import bodyParser from 'body-parser';
import firebasedAdmin from 'firebase-admin';
import express from 'express';
import puppeteer from 'puppeteer';

import Twitter from './public/twitter.mjs';
import * as feeds from './public/feeds.mjs';
import * as util from './public/util.mjs';
import {BLOG_TO_AUTHOR} from './public/shared.mjs';

// const dbHelper = require('./public/db.mjs');
// console.log(dbHelper.fetchPosts());

firebasedAdmin.initializeApp({
  // credential: firebasedAdmin.credential.applicationDefault()
  credential: firebasedAdmin.credential.cert(
      JSON.parse(fs.readFileSync('./serviceAccountKey.json')))
});

const db = firebasedAdmin.firestore();
const app = express();

const PARTIALS_CACHE = new Map();
const FIREBASE_CACHE = new Map();
const CACHE_REST_QUERIES = false;

app.use(function forceSSL(req, res, next) {
  if (req.hostname !== 'localhost' && req.get('X-Forwarded-Proto') === 'http') {
    res.redirect(`https://${req.hostname}${req.url}`);
  }
  next();
});

app.use((req, res, next) => {
  req.getCurrentUrl = () => `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  req.getOrigin = () => `${req.protocol}://${req.get('host')}`;
  next();
});

// app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

app.use(express.static('public', {extensions: ['html', 'htm']}));
app.use(express.static('node_modules/lit-html'));
// app.use(function cors(req, res, next) {
//   res.header('Access-Control-Allow-Origin', '*');
//   // res.header('Content-Type', 'application/json;charset=utf-8');
//   // res.header('Cache-Control', 'public, max-age=300, s-maxage=600');
//   next();
// });

function updateRSSFeedsDaily() {
  console.info('Updating RSS feeds...');
  const dayInMilliseconds = 1000 * 60 * 60 * 24;
  const tick = Date.now();
  feeds.updateFeeds().then(() => {
    console.info(`feed update took ${(Date.now() - tick)/1000}s`);
  });
  setTimeout(updateRSSFeedsDaily, dayInMilliseconds);
}

/**
 * @return {!Promise} Resolves when the post has been added to the db.
 */
async function newPost(post) {
  const url = post.url;
  const submitted = new Date(post.submitted);
  const year = String(submitted.getFullYear());
  const month = String(submitted.getMonth() + 1).padStart(2, '0');
  const day = String(submitted.getDate()).padStart(2, '0');

  const doc = db.collection(year).doc(month);
  if (!(await doc.get()).exists) {
    await doc.create({items: []});
  }

  const items = (await doc.get()).data().items;

  // If post is from gist, lookup author name.
  const githubAuthor = BLOG_TO_AUTHOR.find((item, i) => {
    return item.github && url.match(item.github)
  });
  if (githubAuthor) {
    post.author = githubAuthor.author;
  }

  // Don't add a dupe.
  if (items.find(item => item.url === url)) {
    return;
  }

  items.push(post);

  return doc.update({items});
}

// /**
//  * @return {!Promise} Resolves when the post has been deleted from the db.
//  */
// async function deletePost(year, month, url) {
//   const doc = db.collection(year).doc(month);
//   const items = (await doc.get()).data().items;
//   const idx = items.findIndex(item => item.url === url);
//   if (idx !== -1) {
//     items.splice(idx, 1);
//     return docRef.update({items});
//   }
// }

app.post('/posts', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  await newPost(req.body);
  res.status(200).send('Success!');
});

async function ssr(url) {
  if (PARTIALS_CACHE.has(url)) {
    return PARTIALS_CACHE.get(url);
  }

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('#posts'); // wait for posts to be in filled in page.
  const html = await page.content(); // Browser "SSR" page for us! Get serialized DOM.
  await browser.close();

  PARTIALS_CACHE.set(url, html); // cache rendered page.

  return html;
}

app.get('/ssr', async (req, res) => {
  const html = await ssr(req.getOrigin());
  // res.status(200).send(postsHTML);//await page.content());
  res.status(200).send(html);
});

// app.delete('/posts/:year?/:month?/:idx?', async (req, res) => {
//   const year = req.params.year;r

//   const month = req.params.month.padStart(2, '0');
//   const itemsIdx = req.params.idx;

//   await deletePost(year, month, itemsIdx);
//   res.status(200).send('Success!');
// });

app.get('/tweets/:username', async (req, res) => {
  const username = req.params.username;
  const twitter = new Twitter();
  res.status(200).json(await twitter.getTweets(username));
});

app.get('/posts/update_rss', async (req, res) => {
  res.status(200).json(await feeds.updateFeeds());
});

async function getPosts(year, month, day, path, maxResults = null) {
  let items = [];
  if (FIREBASE_CACHE.has(path)) {
    items = FIREBASE_CACHE.get(path);
  } else {
    const postsCollection =  db.collection(year);

    items = await feeds.collectRSSFeeds(); // First set RSS items.

    // Filter out RSS items not in the year.
    items = items.filter(item => {
      const submitted = new Date(item.submitted);
      return submitted.getFullYear() === parseInt(year);
    });

    if (month) {
      // Filter out RSS items not in the month.
      items = items.filter(item => {
        const submitted = new Date(item.submitted);
        return (submitted.getMonth() + 1) === parseInt(month);
      });

      const doc = await postsCollection.doc(month).get();
      if (doc.exists) {
        items.push(...doc.data().items);
      }
    } else {
      const querySnapshot = await postsCollection.get();
      for (const doc of querySnapshot.docs) {
        items.push(...(await doc.ref.get()).data().items);
      }
    }

    // Filter out items not in the day.
    if (day) {
      items = items.filter(item => {
        const submitted = new Date(item.submitted);
        return submitted.getDate() === parseInt(day);
      });
    }

    // TODO: construct a db query that returns sorted results.
    util.sortPosts(items);

    // if (doc.exists) {
    //   console.log(doc.data())
    //   items = doc.data().items;
    // } else {
    //   console.warn(`No posts exist for ${doc.id}.`);
    // }

    if (CACHE_REST_QUERIES) {
      FIREBASE_CACHE.set(path, items);
    }
  }

  // TODO: use limit() on Firebase query.
  if (maxResults) {
    items = items.slice(0, maxResults);
  }

  return items;
}

app.get('/posts/:year?/:month?/:day?', async (req, res) => {
  const year = req.params.year;
  // Pad values if missing leading '0'.
  const month = req.params.month ? req.params.month.padStart(2, '0') : null;
  const day = req.params.day ? req.params.day.padStart(2, '0') : null;
  const maxResults = req.query.maxresults ? Number(req.query.maxresults) : null;

  if (!year) {
    return res.status(400).send({error: 'No year specified.'});
  }

  const posts = await getPosts(year, month, day, req.path, maxResults);
  res.status(200).send(posts);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
  updateRSSFeedsDaily();
});