#!/usr/bin/env bash
# Run once in the owner's authenticated Cloud Shell. No keys or GitHub secrets.
set -euo pipefail
trap 'printf "\nהחיבור לא הושלם. יש לבדוק את השגיאה שמופיעה למעלה ולנסות שוב.\n" >&2' ERR

ksa_project=kiri-store-accounting
ksa_expected_number=292191260602
ksa_pool=ksa-hosting-github
ksa_provider=github
ksa_service_account=ksa-hosting-deploy
ksa_sa_email="$ksa_service_account@$ksa_project.iam.gserviceaccount.com"
ksa_repo_id=1364339197
ksa_owner_id=292371268

printf 'בודק את הפרויקט ואת ההרשאה של החשבון המחובר…\n'
ksa_number=$(gcloud projects describe "$ksa_project" --format='value(projectNumber)')
if [[ "$ksa_number" != "$ksa_expected_number" ]]; then
  printf 'מספר הפרויקט אינו תואם להגדרת הפרסום. לא בוצע שינוי.\n' >&2
  exit 1
fi
ksa_pool_name="projects/$ksa_number/locations/global/workloadIdentityPools/$ksa_pool"
ksa_provider_name="$ksa_pool_name/providers/$ksa_provider"

printf 'מפעיל את שירותי ההתחברות והפרסום הנדרשים…\n'
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com cloudresourcemanager.googleapis.com \
  firebase.googleapis.com firebasehosting.googleapis.com \
  --project="$ksa_project" --quiet

printf 'מכין חשבון ייעודי לפרסום האתר…\n'
ksa_existing_sa=$(gcloud iam service-accounts list --project="$ksa_project" \
  --filter="email=$ksa_sa_email" --format='value(email)')
if [[ -z "$ksa_existing_sa" ]]; then
  gcloud iam service-accounts create "$ksa_service_account" \
    --project="$ksa_project" --display-name='KSA GitHub Hosting deployer' --quiet
fi

# These roles grant Hosting publication and API use, not access to invoice data,
# Storage documents, secrets, Cloud Run deployment, or IAM administration.
for ksa_role in roles/firebasehosting.admin roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$ksa_project" \
    --member="serviceAccount:$ksa_sa_email" --role="$ksa_role" \
    --condition=None --quiet --format=none
done

printf 'מחבר את הפרסום למאגר ולענף main בלבד…\n'
ksa_existing_pool=$(gcloud iam workload-identity-pools list \
  --project="$ksa_project" --location=global \
  --filter="name=$ksa_pool_name" --format='value(name)')
if [[ -z "$ksa_existing_pool" ]]; then
  gcloud iam workload-identity-pools create "$ksa_pool" \
    --project="$ksa_project" --location=global \
    --display-name='KSA Hosting GitHub' --quiet
fi

# Numeric identities prevent trust from following a reused repo name or a
# transfer to another owner. Every condition claim is mapped explicitly.
ksa_mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.event_name=assertion.event_name'
ksa_condition="attribute.repository_id == '$ksa_repo_id' && attribute.repository_owner_id == '$ksa_owner_id' && attribute.ref == 'refs/heads/main' && attribute.workflow_ref == 'asafkiri/kiri-store-accounting/.github/workflows/ci.yml@refs/heads/main' && attribute.event_name in ['push', 'workflow_dispatch']"
ksa_existing_provider=$(gcloud iam workload-identity-pools providers list \
  --project="$ksa_project" --location=global --workload-identity-pool="$ksa_pool" \
  --filter="name=$ksa_provider_name" --format='value(name)')
ksa_provider_action=create-oidc
if [[ -n "$ksa_existing_provider" ]]; then
  ksa_provider_action=update-oidc
fi
gcloud iam workload-identity-pools providers "$ksa_provider_action" "$ksa_provider" \
  --project="$ksa_project" --location=global --workload-identity-pool="$ksa_pool" \
  --display-name='KSA main Hosting workflow' \
  --issuer-uri='https://token.actions.githubusercontent.com' \
  --attribute-mapping="$ksa_mapping" --attribute-condition="$ksa_condition" --quiet

gcloud iam service-accounts add-iam-policy-binding "$ksa_sa_email" \
  --project="$ksa_project" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$ksa_pool_name/attribute.repository_id/$ksa_repo_id" \
  --condition=None --quiet --format=none

printf '\nהחיבור לפרסום אוטומטי הוגדר בהצלחה.\n'
printf 'ההרשאות עשויות להתעדכן במשך עד חמש דקות.\n'
printf 'לאחר מיזוג ההגדרה, הבדיקות והפרסום יופיעו כאן:\n'
printf 'https://github.com/asafkiri/kiri-store-accounting/actions\n'
