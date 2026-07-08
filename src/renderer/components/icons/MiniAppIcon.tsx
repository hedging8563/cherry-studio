import { cn } from '@cherrystudio/ui/lib/utils'
import { getMiniAppsLogo, isMiniAppLogoFullBleed } from '@renderer/components/icons/miniAppsLogo'
import type { MiniApp } from '@shared/data/types/miniApp'
import type { FC } from 'react'

interface Props {
  app: Pick<MiniApp, 'logo' | 'name' | 'background' | 'bordered'>
  /** `avatar` keeps the bordered Avatar chrome; `plain` strips it from icon logos; `bare` also strips it from image logos. */
  appearance?: 'avatar' | 'plain' | 'bare'
  size?: number
  style?: React.CSSProperties
}

const MiniAppIcon: FC<Props> = ({ app, appearance = 'avatar', size = 48, style }) => {
  // Preset-derived apps already include seeded display fields.
  if (app.logo) {
    const logo = getMiniAppsLogo(app.logo)
    const chromeless = appearance === 'plain' || appearance === 'bare'

    // CompoundIcon: default usages keep the Avatar wrapper; Launchpad-style tiles render the logo itself.
    if (logo && typeof logo !== 'string') {
      const Icon = logo
      if (chromeless) {
        if (appearance === 'plain') {
          // Plate artwork fills the tile edge-to-edge without chrome (v1 rendered logos
          // full-bleed and clipped them with the tile radius); everything else shows the
          // logo scaled and centered inside a hairline tile.
          if (isMiniAppLogoFullBleed(app.logo)) {
            return (
              <span
                className="flex shrink-0 select-none items-center justify-center overflow-hidden rounded-[24%]"
                style={{ width: `${size}px`, height: `${size}px`, userSelect: 'none', ...style }}>
                {/* 108% bleed swallows the ~2% transparent margin cropped viewBoxes still carry. */}
                <Icon
                  aria-label={app.name || 'MiniApp Icon'}
                  className="shrink-0"
                  style={{ width: '108%', height: '108%' }}
                />
              </span>
            )
          }
          return (
            <span
              className="flex shrink-0 select-none items-center justify-center overflow-hidden rounded-[24%] border border-border"
              style={{ width: `${size}px`, height: `${size}px`, userSelect: 'none', ...style }}>
              <Icon aria-label={app.name || 'MiniApp Icon'} style={{ width: '74%', height: '74%' }} />
            </span>
          )
        }
        // `bare` (tiny sidebar icons) always renders the raw icon.
        return (
          <Icon
            aria-label={app.name || 'MiniApp Icon'}
            className="shrink-0 select-none overflow-hidden rounded-[24%]"
            style={{ width: `${size}px`, height: `${size}px`, userSelect: 'none', ...style }}
          />
        )
      }

      return <Icon.Avatar size={size} className="select-none border border-border" shape="rounded" />
    }

    if (appearance === 'bare') {
      return (
        <img
          src={typeof logo === 'string' ? logo : app.logo}
          className="shrink-0 select-none object-contain"
          style={{ width: `${size}px`, height: `${size}px`, userSelect: 'none', ...style }}
          draggable={false}
          alt={app.name || 'MiniApp Icon'}
        />
      )
    }

    return (
      <img
        src={typeof logo === 'string' ? logo : app.logo}
        className={cn('select-none rounded-2xl', app.bordered && 'border border-border')}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          backgroundColor: app.background,
          userSelect: 'none',
          ...style
        }}
        draggable={false}
        alt={app.name || 'MiniApp Icon'}
      />
    )
  }

  return null
}

export default MiniAppIcon
