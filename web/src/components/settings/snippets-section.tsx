import { motion } from 'framer-motion'
import { SlidersHorizontal } from 'lucide-react'

import { springs } from '@/lib/springs'
import { Button } from '@/components/ui/button'
import { Section, Row } from '@/components/settings/primitives'
import { useSnippetsManager } from '@/stores/snippets-manager-store'
import { useSnippets } from '@/hooks/use-commands'

/** Snippets entry — a compact "Manage snippets" row that opens the dedicated
 *  manager sheet, mirroring `ClaudeToolsSection`. The full list + add/edit/delete
 *  lives in <SnippetsManagerSheet> (shell-level, shared via the snippets-manager
 *  store) so it never grows inline and shoves the rest of Settings down. */
export function SnippetsSection() {
  const openManager = useSnippetsManager((s) => s.openSheet)
  const { data } = useSnippets()
  const count = data?.length ?? 0

  return (
    <Section
      title="Snippets"
      footnote="Saved prompts and /commands you reuse — drop them into a session from the composer’s accessory bar."
    >
      <Row
        label="Manage snippets"
        hint={
          count > 0
            ? `${count} saved snippet${count === 1 ? '' : 's'}.`
            : 'Save a prompt or /command you reach for often.'
        }
        control={
          <Button
            asChild
            variant="outline"
            onClick={() => openManager()}
            aria-label="Manage snippets"
            className="h-11 gap-1.5"
          >
            <motion.button whileTap={{ scale: 0.96 }} transition={springs.buttonPress}>
              <SlidersHorizontal />
              Manage
            </motion.button>
          </Button>
        }
      />
    </Section>
  )
}
