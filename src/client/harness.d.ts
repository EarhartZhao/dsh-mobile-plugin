/**
 * Minimal declarations for the dsh client modules this out-of-tree bundle
 * consumes at runtime. The host supplies the implementations; the plugin only
 * needs the exported props and return types that its own renderer uses.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type {
    ButtonHTMLAttributes,
    ReactElement,
    ReactNode,
  } from 'react'

  export interface IconProps {
    size?: number
    className?: string
  }

  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string
    children?: ReactNode
  }): ReactElement

  export function StateDot(props: {
    state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
    size?: number
    className?: string
    appearance?: 'dot' | 'step'
  }): ReactElement

  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }): ReactElement

  export function SegmentedTabs<Value extends string>(props: {
    items: readonly [
      { value: Value; label: ReactNode; id: string; panelId: string },
      ...{ value: Value; label: ReactNode; id: string; panelId: string }[],
    ]
    value: Value
    onChange: (value: Value) => void
    label: string
    className?: string
  }): ReactElement

  export const IconRefreshOutlineRegular: (props: IconProps) => ReactElement
  export const IconPlusOutlineRegular: (props: IconProps) => ReactElement
  export const IconCheckOutlineRegular: (props: IconProps) => ReactElement
  export const IconInfoOutlineRegular: (props: IconProps) => ReactElement
  export const IconLinkOutlineRegular: (props: IconProps) => ReactElement
  export const IconTrashOutlineRegular: (props: IconProps) => ReactElement
  export const IconWarningOutlineRegular: (props: IconProps) => ReactElement
  export const IconChevronDownOutlineRegular: (props: IconProps) => ReactElement
  export const IconSettingsOutlineRegular: (props: IconProps) => ReactElement
}
