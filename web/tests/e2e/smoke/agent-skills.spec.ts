import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend } from './harness'

test.use({ viewport: { width: 1440, height: 960 } })

test('manage a scoped skill and edit nested Markdown in the Store', async ({
  page,
}, info) => {
  const claudeConfigDir = info.outputPath('provider-config')
  await mkdir(claudeConfigDir, { recursive: true })
  const backend = await startBackend({ claudeConfigDir })
  try {
    const installed = join(backend.claudeConfigDir, 'skills', 'release-review')
    await mkdir(join(installed, 'assets'), { recursive: true })
    await writeFile(
      join(installed, 'SKILL.md'),
      '---\nname: release-review\ndescription: Prepare a release\n---\n',
    )
    await writeFile(
      join(installed, 'assets', 'example.bin'),
      Buffer.from([0, 255, 17]),
    )
    await page.addInitScript(injectGlobals(backend.token))
    await page.goto(backend.baseUrl + '/store')
    await expect(
      page.getByRole('link', { name: 'Agent skills', exact: true }),
    ).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath('connectors.png'),
    })
    await page.getByRole('link', { name: 'Agent skills', exact: true }).click()
    await page.getByRole('button', { name: 'Add skill', exact: true }).click()
    await page
      .getByLabel('Import from this server')
      .selectOption({ label: 'release-review · Claude · user' })
    await expect(page.getByLabel('Skill name')).toHaveValue('release-review')
    const manifest =
      '---\nname: release-review\ndescription: Review a release before shipping.\n---\n\nSee references/checklist.md.'
    await page.getByLabel('Markdown content').fill(manifest)
    await page.getByLabel('New Markdown path').fill('references/checklist.md')
    await page.getByRole('button', { name: 'Add file' }).click()
    await page.getByLabel('Markdown content').fill('Verify the changelog.')
    await page.getByRole('button', { name: 'Save skill' }).click()
    await page.getByRole('button', { name: 'Grant', exact: true }).click()
    await expect(page.getByText('Granted via All agents')).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath('library.png'),
    })
    await page.getByRole('button', { name: 'Edit files' }).click()
    const updatedManifest =
      manifest + '\n\nRecord the reviewer in the release notes.'
    await expect(page.getByLabel('Markdown content')).toHaveValue(manifest)
    await page.getByLabel('Markdown content').fill(updatedManifest)
    await page
      .getByLabel('Markdown file', { exact: true })
      .selectOption('references/checklist.md')
    await expect(page.getByLabel('Markdown content')).toHaveValue(
      'Verify the changelog.',
    )
    await page
      .getByLabel('Markdown content')
      .fill('Verify the changelog and run the release tests.')
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath('editor.png'),
    })
    await page.getByRole('button', { name: 'Save skill' }).click()
    const details = await page.request.get(
      backend.backendUrl + '/api/agent-skills/release-review',
      { headers: { Authorization: 'Bearer ' + backend.token } },
    )
    expect((await details.json()).files['assets/example.bin']).toBe(
      Buffer.from([0, 255, 17]).toString('base64'),
    )
    await page.reload()
    await page.getByRole('button', { name: 'Edit files' }).click()
    await expect(page.getByLabel('Markdown content')).toHaveValue(
      updatedManifest,
    )
    await page
      .getByLabel('Markdown file', { exact: true })
      .selectOption('references/checklist.md')
    await expect(page.getByLabel('Markdown content')).toHaveValue(
      'Verify the changelog and run the release tests.',
    )
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(
      page.getByRole('button', { name: 'Save skill' }),
    ).toBeInViewport()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Disable grant' }).click()
    await expect(page.getByText('Grant disabled')).toBeVisible()
    await page.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(page.getByText('Available to grant')).toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Uninstall' }).click()
    await expect(page.getByText('No skills installed.')).toBeVisible()
  } finally {
    await backend.dispose()
  }
})

test.describe('touchscreen bot settings', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  test('grant a skill to one Codex bot and edit its Markdown from Setup', async ({
    page,
  }, info) => {
    const backend = await startBackend({
      claudeConfigDir: info.outputPath('provider-config'),
    })
    const bot = 'release-reviewer'
    const name = 'release-review'
    const headers = { Authorization: 'Bearer ' + backend.token }
    try {
      const session = await api(backend).createSession({
        name: bot,
        dir: backend.dataDir,
        provider: 'codex',
      })
      expect(session.ok).toBe(true)
      const manifest =
        '---\nname: release-review\ndescription: Verify the release candidate.\n---\n'
      const skill = await page.request.put(
        backend.backendUrl + '/api/agent-skills/' + name,
        {
          headers,
          data: {
            files: {
              'SKILL.md': Buffer.from(manifest).toString('base64'),
              'references/checklist.md': Buffer.from(
                'Check the changelog.',
              ).toString('base64'),
            },
          },
        },
      )
      expect(skill.ok()).toBe(true)
      await page.addInitScript(injectGlobals(backend.token))
      await page.goto(backend.baseUrl + '/focus/' + bot)
      await page
        .getByRole('button', { name: /bot details|Session info —/i })
        .click()
      await page.getByRole('tab', { name: 'Setup' }).click()
      await page.getByRole('button', { name: 'Manage skills' }).click()
      const sheet = page.getByRole('dialog', {
        name: 'Agent skills for ' + bot,
      })
      await sheet.getByRole('button', { name: 'Grant', exact: true }).click()
      await expect(
        sheet.getByText('Granted via release-reviewer · Codex'),
      ).toBeVisible()
      await sheet.getByRole('button', { name: 'Edit files' }).click()
      const markdown = page.getByLabel('Markdown content')
      await expect(markdown).toHaveValue(manifest)
      await page
        .getByLabel('Markdown file', { exact: true })
        .selectOption('references/checklist.md')
      await markdown.fill('Verify the signed build on mobile.')
      await page.screenshot({
        animations: 'disabled',
        path: info.outputPath('mobile-editor.png'),
      })
      await page.getByRole('button', { name: 'Save skill' }).click()
      await expect(
        sheet.getByRole('button', { name: 'Edit files' }),
      ).toBeVisible()
      await sheet.getByRole('button', { name: 'Edit files' }).click()
      await page
        .getByLabel('Markdown file', { exact: true })
        .selectOption('references/checklist.md')
      await expect(markdown).toHaveValue('Verify the signed build on mobile.')
      const global = await page.request.get(
        backend.backendUrl + '/api/agent-skills?target=*',
        { headers },
      )
      expect((await global.json()).effective).not.toHaveProperty(name)
    } finally {
      await backend.dispose()
    }
  })
})
