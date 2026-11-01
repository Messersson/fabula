'use strict';

// 评审/落改的硬上限。宁可明确拒绝，也不把半截稿子写回去。
//
// APPLY_INPUT_MAX_CHARS 同时是「提示词里必须放全文」的上限：
// 超过它就分段处理或手工改，而不是截掉后半段再让模型输出「完整正文」。
const REVIEW_TEXT_MAX_CHARS = 24000;
const APPLY_INPUT_MAX_CHARS = 6000;
const APPLY_MIN_KEEP_RATIO = 0.85;
const AUTO_REVIEW_LIMIT = 30;

module.exports = {
  REVIEW_TEXT_MAX_CHARS,
  APPLY_INPUT_MAX_CHARS,
  APPLY_MIN_KEEP_RATIO,
  AUTO_REVIEW_LIMIT,
};
