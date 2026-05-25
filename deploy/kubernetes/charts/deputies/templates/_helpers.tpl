{{- define "deputies.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "deputies.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "deputies.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "deputies.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "deputies.labels" -}}
helm.sh/chart: {{ include "deputies.chart" . }}
app.kubernetes.io/name: {{ include "deputies.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "deputies.selectorLabels" -}}
app.kubernetes.io/name: {{ include "deputies.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "deputies.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "deputies.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "deputies.secretName" -}}
{{- default (printf "%s-app" (include "deputies.fullname" .)) .Values.secrets.name -}}
{{- end -}}

{{- define "deputies.postgresSecretName" -}}
{{- default (printf "%s-postgres" (include "deputies.fullname" .)) .Values.postgres.existingSecret -}}
{{- end -}}

{{- define "deputies.controlPlaneEnv" -}}
{{- $root := .root -}}
{{- $runMode := .runMode -}}
{{- $port := .port -}}
- name: PORT
  value: {{ $port | quote }}
- name: RUN_MODE
  value: {{ $runMode | quote }}
- name: RUNNER
  value: {{ $root.Values.config.runner | quote }}
- name: SANDBOX_PROVIDER
  value: {{ $root.Values.config.sandboxProvider | quote }}
- name: SANDBOX_WORKSPACE_PATH
  value: {{ $root.Values.config.sandboxWorkspacePath | quote }}
- name: APP_DATA_STORE
  value: {{ $root.Values.config.appDataStore | quote }}
- name: FLUE_STATE_STORE
  value: {{ $root.Values.config.flueStateStore | quote }}
- name: API_AUTH_MODE
  value: {{ $root.Values.config.apiAuthMode | quote }}
- name: AUTH_PROVIDER
  value: {{ $root.Values.config.authProvider | quote }}
{{- if $root.Values.config.authCookieDomain }}
- name: AUTH_COOKIE_DOMAIN
  value: {{ $root.Values.config.authCookieDomain | quote }}
{{- end }}
- name: AUTH_COOKIE_SECURE
  value: {{ $root.Values.config.authCookieSecure | quote }}
- name: AUTH_COOKIE_SAME_SITE
  value: {{ $root.Values.config.authCookieSameSite | quote }}
- name: WEB_BASE_URL
  value: {{ $root.Values.config.webBaseUrl | quote }}
- name: SERVICE_BASE_DOMAIN
  value: {{ $root.Values.config.serviceBaseDomain | quote }}
- name: SERVICE_TRUST_FORWARDED_HOSTS
  value: {{ $root.Values.config.serviceTrustForwardedHosts | quote }}
- name: FLUE_MODEL
  value: {{ $root.Values.config.flueModel | quote }}
- name: DAYTONA_IMAGE
  value: {{ $root.Values.config.daytonaImage | quote }}
- name: HIDE_SETUP_PAGE
  value: {{ $root.Values.config.hideSetupPage | quote }}
{{- if $root.Values.config.daytonaApiUrl }}
- name: DAYTONA_API_URL
  value: {{ $root.Values.config.daytonaApiUrl | quote }}
{{- end }}
{{- if $root.Values.config.daytonaTarget }}
- name: DAYTONA_TARGET
  value: {{ $root.Values.config.daytonaTarget | quote }}
{{- end }}
{{- if $root.Values.config.daytonaSnapshot }}
- name: DAYTONA_SNAPSHOT
  value: {{ $root.Values.config.daytonaSnapshot | quote }}
{{- end }}
- name: ARTIFACT_STORAGE_PROVIDER
  value: {{ $root.Values.config.artifactStorageProvider | quote }}
- name: ARTIFACT_STORAGE_S3_ENDPOINT
  value: {{ $root.Values.config.artifactStorageS3Endpoint | quote }}
- name: ARTIFACT_STORAGE_S3_REGION
  value: {{ $root.Values.config.artifactStorageS3Region | quote }}
- name: ARTIFACT_STORAGE_S3_BUCKET
  value: {{ $root.Values.config.artifactStorageS3Bucket | quote }}
- name: ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE
  value: {{ $root.Values.config.artifactStorageS3ForcePathStyle | quote }}
- name: ARTIFACT_STORAGE_S3_CREATE_BUCKET
  value: {{ $root.Values.config.artifactStorageS3CreateBucket | quote }}
- name: POSTGRES_USER
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" $root }}
      key: {{ $root.Values.postgres.secretKeys.username }}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" $root }}
      key: {{ $root.Values.postgres.secretKeys.password }}
- name: POSTGRES_DATABASE
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" $root }}
      key: {{ $root.Values.postgres.secretKeys.database }}
- name: POSTGRES_HOST
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" $root }}
      key: {{ $root.Values.postgres.secretKeys.host }}
- name: POSTGRES_PORT
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" $root }}
      key: {{ $root.Values.postgres.secretKeys.port }}
- name: DATABASE_URL
  value: postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@$(POSTGRES_HOST):$(POSTGRES_PORT)/$(POSTGRES_DATABASE){{ ternary (printf "?sslmode=%s" $root.Values.postgres.sslMode) "" (ne $root.Values.postgres.sslMode "") }}
{{- range $name, $value := $root.Values.config.extraEnv }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}

{{- define "deputies.apiServiceName" -}}
{{- printf "%s-api" (include "deputies.fullname" .) -}}
{{- end -}}
