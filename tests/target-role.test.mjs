/**
 * Tests for `targetRoleFromCardPath` — the rule that decides which window a card reaches.
 *
 * This is the single highest-risk piece of the plugin: a wrong answer sends work to the
 * wrong window, and the failure is silent (the wrong window starts working on a card
 * meant for someone else). So the rule is deliberately narrow, and these tests pin both
 * what it must accept and what it must refuse to guess at.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { targetRoleFromCardPath } from '../session-relay.mjs'

describe('targetRoleFromCardPath — the naming convention', () => {
  test('reads the role from a trailing full-width bracket', () => {
    assert.equal(
      targetRoleFromCardPath('2026-03-01-派工单-重构解析链（后端窗口）.md'),
      '后端窗口',
    )
  })

  test('accepts half-width brackets too', () => {
    assert.equal(targetRoleFromCardPath('card-（前端窗口）.md'.replace('（', '(').replace('）', ')')), '前端窗口')
  })

  test('accepts the other common role names', () => {
    for (const role of ['前端窗口', '后端窗口', '测试窗口', '文档窗口', '运维窗口']) {
      assert.equal(targetRoleFromCardPath(`2026-03-01-派工单-x（${role}）.md`), role)
    }
  })

  test('works with directories, Windows separators, and other card extensions', () => {
    assert.equal(targetRoleFromCardPath('cards/sub/派工单（测试窗口）.markdown'), '测试窗口')
    assert.equal(targetRoleFromCardPath('D:\\project\\_ops\\派工单（后端窗口）.md'), '后端窗口')
    assert.equal(targetRoleFromCardPath('notes/派工单（后端窗口）.txt'), '后端窗口')
  })
})

describe('targetRoleFromCardPath — compound dates', () => {
  test('strips a "·date" suffix, which is how finished cards are dated', () => {
    assert.equal(
      targetRoleFromCardPath('2026-03-01-回报-重构解析链（后端窗口·20260302）.md'),
      '后端窗口',
    )
  })

  test('strips only the first "·" segment', () => {
    assert.equal(targetRoleFromCardPath('x（后端窗口·20260302·extra）.md'), '后端窗口')
  })
})

describe('targetRoleFromCardPath — must refuse to guess', () => {
  test('returns undefined for a date-only report, which names no target', () => {
    // Real-world shape: a report file dated but not addressed. Guessing here would be
    // exactly the bug this rule exists to prevent.
    assert.equal(targetRoleFromCardPath('2026-03-01-回报（20260302）.md'), undefined)
  })

  test('returns undefined when the bracketed text is not a "…窗口" role', () => {
    assert.equal(targetRoleFromCardPath('2026-03-01-派工单（某人代跑）.md'), undefined)
    assert.equal(targetRoleFromCardPath('2026-03-01-派工单（补录）.md'), undefined)
  })

  test('returns undefined when there is no trailing bracket at all', () => {
    assert.equal(targetRoleFromCardPath('2026-03-01-派工单-重构解析链.md'), undefined)
  })

  test('does NOT match a window name that appears merely inside the title', () => {
    // The card number contains "FE" and the title says "后端", but the target is stated
    // only by the trailing bracket. Substring matching would send this to the wrong window.
    assert.equal(
      targetRoleFromCardPath('T-142-派工单-后端缺口复核.md'),
      undefined,
    )
    assert.equal(
      targetRoleFromCardPath('T-142-派工单-后端缺口复核（前端窗口）.md'),
      '前端窗口',
    )
  })

  test('returns undefined for malformed or hostile input rather than throwing', () => {
    for (const value of [undefined, null, '', 42, {}, [], 'x（后端窗口']) {
      assert.equal(targetRoleFromCardPath(value), undefined, `input: ${String(value)}`)
    }
  })

  test('rejects a role containing control characters', () => {
    assert.equal(targetRoleFromCardPath('x（后端\u0000窗口）.md'), undefined)
  })

  test('rejects an implausibly long role name', () => {
    assert.equal(targetRoleFromCardPath(`x（${'长'.repeat(40)}窗口）.md`), undefined)
  })

  test('uses the LAST bracket group, since the target is always at the end', () => {
    assert.equal(
      targetRoleFromCardPath('派工单（草稿）-重构（后端窗口）.md'),
      '后端窗口',
    )
  })
})
