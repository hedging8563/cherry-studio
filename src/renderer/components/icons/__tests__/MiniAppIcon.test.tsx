import { render } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

import MiniAppIcon from '../MiniAppIcon'

vi.mock('@renderer/components/icons/miniAppsLogo', () => ({
  isMiniAppLogoFullBleed: (logo: unknown) => logo === 'full-bleed-logo',
  getMiniAppsLogo: (logo: unknown) => {
    if (logo !== 'compound-logo' && logo !== 'full-bleed-logo') return logo
    const CompoundLogo = ({
      'aria-label': ariaLabel,
      className,
      style,
      variant
    }: React.SVGProps<SVGSVGElement> & { variant?: 'light' | 'dark' }) => (
      <svg
        aria-label={ariaLabel}
        className={className}
        data-testid="compound-logo"
        data-variant={variant ?? 'auto'}
        style={style}
      />
    )
    CompoundLogo.Avatar = ({ className, size = 32 }: { className?: string; size?: number }) => (
      <div className={className} data-testid="compound-logo-avatar" style={{ width: size, height: size }}>
        <div data-testid="compound-logo-fallback" data-slot="avatar-fallback">
          <CompoundLogo style={{ width: size * 0.7, height: size * 0.7 }} />
        </div>
      </div>
    )
    CompoundLogo.colorPrimary = '#000000'
    return CompoundLogo
  }
}))

describe('MiniAppIcon', () => {
  const mockApp = {
    appId: 'test-app-1' as any,
    presetMiniAppId: 'test-preset',
    status: 'enabled' as const,
    orderKey: 'a0',
    name: 'Test App',
    url: 'https://test.com',
    logo: '/test-logo-1.png',
    bordered: true,
    background: '#f0f0f0'
  }

  it('should render correctly with various props', () => {
    const customStyle = { marginTop: '10px' }
    const { container } = render(<MiniAppIcon app={mockApp} size={64} style={customStyle} />)

    const img = container.querySelector('img')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', '/test-logo-1.png')
    expect(img).toHaveAttribute('alt', 'Test App')
    expect(img).toHaveAttribute('draggable', 'false')
    expect(img).toHaveStyle({
      width: '64px',
      height: '64px',
      marginTop: '10px',
      backgroundColor: '#f0f0f0'
    })
  })

  it('should return null when app is not found in allMiniApps', () => {
    const unknownApp = {
      appId: 'unknown-app' as any,
      presetMiniAppId: 'test-preset',
      status: 'enabled' as const,
      orderKey: 'a0',
      name: 'Unknown App',
      url: 'https://unknown.com'
    }
    const { container } = render(<MiniAppIcon app={unknownApp} />)

    expect(container.firstChild).toBeNull()
  })

  it('renders compound icons as avatar by default', () => {
    const { container } = render(<MiniAppIcon app={{ ...mockApp, logo: 'compound-logo' }} size={48} />)

    const avatar = container.querySelector('[data-testid="compound-logo-avatar"]')
    expect(avatar).toBeInTheDocument()
    expect(avatar).toHaveClass('border', 'border-border')
    expect(avatar).not.toHaveClass('[&_[data-slot=avatar-fallback]]:bg-transparent')
  })

  it('centers plain bare-mark icons inside a bordered tile', () => {
    const { container } = render(
      <MiniAppIcon app={{ ...mockApp, logo: 'compound-logo' }} appearance="plain" size={48} />
    )

    expect(container.querySelector('[data-testid="compound-logo-avatar"]')).not.toBeInTheDocument()
    const tile = container.firstChild as HTMLElement
    expect(tile.tagName).toBe('SPAN')
    expect(tile).toHaveClass('border', 'border-border')
    expect(tile).toHaveStyle({ width: '48px', height: '48px' })
    const icon = container.querySelector('[data-testid="compound-logo"]')
    expect(icon).toBeInTheDocument()
    expect(icon).toHaveStyle({ width: '74%', height: '74%' })
  })

  it('renders plain full-bleed plates edge-to-edge in a borderless clipping tile', () => {
    const { container } = render(
      <MiniAppIcon app={{ ...mockApp, logo: 'full-bleed-logo' }} appearance="plain" size={40} />
    )

    expect(container.querySelector('[data-testid="compound-logo-avatar"]')).not.toBeInTheDocument()
    const tile = container.firstChild as HTMLElement
    expect(tile.tagName).toBe('SPAN')
    expect(tile).toHaveClass('overflow-hidden')
    expect(tile).not.toHaveClass('border')
    expect(tile).toHaveStyle({ width: '40px', height: '40px' })
    const icon = container.querySelector('[data-testid="compound-logo"]')
    expect(icon).toBeInTheDocument()
    expect(icon).toHaveStyle({ width: '108%', height: '108%' })
  })

  it('borders image logos only when the app is flagged bordered', () => {
    const { container: bordered } = render(<MiniAppIcon app={mockApp} />)
    expect(bordered.querySelector('img')).toHaveClass('border', 'border-border')

    const { container: borderless } = render(<MiniAppIcon app={{ ...mockApp, bordered: undefined }} />)
    expect(borderless.querySelector('img')).not.toHaveClass('border')
  })

  it('renders bare icons directly without border chrome', () => {
    const { container } = render(
      <MiniAppIcon app={{ ...mockApp, logo: 'compound-logo' }} appearance="bare" size={16} />
    )

    const icon = container.querySelector('[data-testid="compound-logo"]')
    expect(icon).toBe(container.firstChild)
    expect(icon).not.toHaveClass('border')
    expect(icon).toHaveStyle({ width: '16px', height: '16px' })
  })
})
