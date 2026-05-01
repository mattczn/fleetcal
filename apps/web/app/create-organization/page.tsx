import { CreateOrganization } from '@clerk/nextjs'

export default function CreateOrganizationPage() {
  return (
    <div className="flex h-full items-center justify-center">
      <CreateOrganization afterCreateOrganizationUrl="/calendar" />
    </div>
  )
}
