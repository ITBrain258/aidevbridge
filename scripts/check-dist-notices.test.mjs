import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNotices } from './check-dist-notices.mjs';

const CSS_NOTICE = '/*!\n * Copyright (c) 2014 The xterm.js authors. All rights reserved.\n */';
const JS_NOTICE = '/**\n* Copyright (c) 2014-2024 The xterm.js authors. All rights reserved.\n* @license MIT\n*/';
const css = (text) => ({ name: 'index-a.css', text });
const js = (text) => ({ name: 'index-a.js', text });

test('a build with both notices passes', () => {
  assert.deepEqual(checkNotices([css(`${CSS_NOTICE}\n.xterm{}`), js(`var a;${JS_NOTICE}var b;`)]), []);
});

test('a CSS file whose notice is not at the start fails', () => {
  const problems = checkNotices([css(`.xterm{}${CSS_NOTICE}`), js(JS_NOTICE)]);
  assert.deepEqual(problems, ['index-a.css does not start with /*!']);
});

test('a CSS file without the copyright fails', () => {
  const problems = checkNotices([css('/*! other */.xterm{}'), js(JS_NOTICE)]);
  assert.deepEqual(problems, ['index-a.css lacks a comment with Copyright, The xterm.js authors']);
});

test('every CSS file needs the notice, one JS file is enough', () => {
  const problems = checkNotices([
    css(CSS_NOTICE),
    { name: 'second-b.css', text: '.x{}' },
    js(JS_NOTICE),
    { name: 'other-c.js', text: 'var c;' },
  ]);
  assert.deepEqual(problems, [
    'second-b.css does not start with /*!',
    'second-b.css lacks a comment with Copyright, The xterm.js authors',
  ]);
});

test('JS without the MIT header fails, and so does a build without CSS', () => {
  assert.deepEqual(checkNotices([js('/* Copyright The xterm.js authors */')]), [
    'no .css file in the build',
    'no .js file has a comment with Copyright, The xterm.js authors, @license MIT',
  ]);
});
