import type { Assistant } from '@renderer/types/assistant'
import type { AssistantIconType } from '@shared/data/preference/preferenceTypes'
import { DEFAULT_ASSISTANT_EMOJI } from '@shared/data/presets/defaultAssistant'

import { renderAssistantEntityIcon } from './base'
import type { ResourceEntityRailItem } from './ResourceEntityRail'

export const DEFAULT_ASSISTANT_ENTITY_ID = 'assistant-entity:default'

interface BuildAssistantEntityItemsOptions {
  assistantIconType: AssistantIconType
  assistantPinnedIds: readonly string[]
  assistants: readonly Assistant[]
  defaultAssistantName?: string
  defaultModelId?: string | null
  includeDefaultAssistant?: boolean
}

export function buildAssistantEntityItems({
  assistantIconType,
  assistantPinnedIds,
  assistants,
  defaultAssistantName,
  defaultModelId,
  includeDefaultAssistant = false
}: BuildAssistantEntityItemsOptions): ResourceEntityRailItem[] {
  const assistantPinnedIdSet = new Set(assistantPinnedIds)
  const assistantItems: ResourceEntityRailItem[] = assistants.map((assistant) => ({
    id: assistant.id,
    name: assistant.name,
    orderKey: assistant.orderKey,
    pinned: assistantPinnedIdSet.has(assistant.id),
    tag: assistant.tags?.[0]?.name,
    icon: renderAssistantEntityIcon(
      assistantIconType,
      {
        emoji: assistant.emoji,
        modelId: assistant.modelId,
        modelName: assistant.modelName
      },
      defaultModelId
    )
  }))

  const pinnedItems = assistantItems.filter((assistant) => assistant.pinned)
  const orderedItems =
    pinnedItems.length > 0
      ? [...pinnedItems, ...assistantItems.filter((assistant) => !assistant.pinned)]
      : assistantItems

  if (!includeDefaultAssistant || !defaultAssistantName) {
    return orderedItems
  }

  return [
    ...orderedItems,
    {
      id: DEFAULT_ASSISTANT_ENTITY_ID,
      name: defaultAssistantName,
      icon: renderAssistantEntityIcon(
        assistantIconType,
        {
          emoji: DEFAULT_ASSISTANT_EMOJI
        },
        defaultModelId
      ),
      reorderable: false
    }
  ]
}
