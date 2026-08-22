import { Button, Card, CardBody, CardFooter, Tooltip } from '@heroui/react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { TbPlugConnected } from 'react-icons/tb'

interface Props {
  iconOnly?: boolean
}

const OutletCard: React.FC<Props> = (props) => {
  const { iconOnly } = props
  const { t } = useTranslation()
  const { appConfig } = useAppConfig()
  const { outletCardStatus = 'col-span-1', disableAnimations = false } = appConfig || {}
  const location = useLocation()
  const navigate = useNavigate()
  const match = location.pathname.includes('/outlet')
  const enabledCount = (appConfig?.scriptOutlets || []).filter((outlet) => outlet.enable).length
  const {
    attributes,
    listeners,
    setNodeRef,
    transform: tf,
    transition,
    isDragging
  } = useSortable({ id: 'outlet' })
  const transform = tf ? { x: tf.x, y: tf.y, scaleX: 1, scaleY: 1 } : null

  if (iconOnly) {
    return (
      <div className={`${outletCardStatus} flex justify-center`}>
        <Tooltip content={t('sider.cards.outlet')} placement="right">
          <Button
            size="sm"
            isIconOnly
            color={match ? 'primary' : 'default'}
            variant={match ? 'solid' : 'light'}
            onPress={() => navigate('/outlet')}
          >
            <TbPlugConnected className="text-[20px]" />
          </Button>
        </Tooltip>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 'calc(infinity)' : undefined
      }}
      className={`${outletCardStatus} outlet-card`}
    >
      <Card
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        fullWidth
        className={`${match ? 'bg-primary' : 'hover:bg-primary/30'} ${disableAnimations ? '' : `motion-reduce:transition-transform-background ${isDragging ? 'scale-[0.95] tap-highlight-transparent' : ''}`}`}
      >
        <CardBody className="pb-1 pt-0 px-0">
          <div className="flex justify-between items-start">
            <Button
              isIconOnly
              className="bg-transparent pointer-events-none"
              variant="flat"
              color="default"
            >
              <TbPlugConnected
                className={`${match ? 'text-primary-foreground' : 'text-foreground'} text-[24px] font-bold`}
              />
            </Button>
            <div
              className={`pt-3 pr-3 text-sm ${match ? 'text-primary-foreground' : 'text-foreground-500'}`}
            >
              {enabledCount > 0 ? enabledCount : ''}
            </div>
          </div>
        </CardBody>
        <CardFooter className="pt-1">
          <h3
            className={`text-md font-bold text-ellipsis whitespace-nowrap overflow-hidden ${match ? 'text-primary-foreground' : 'text-foreground'}`}
          >
            {t('sider.cards.outlet')}
          </h3>
        </CardFooter>
      </Card>
    </div>
  )
}

export default OutletCard
