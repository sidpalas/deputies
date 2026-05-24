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
- name: PORT
  value: {{ .Values.controlPlane.service.port | quote }}
- name: RUN_MODE
  value: {{ .Values.config.runMode | quote }}
- name: RUNNER
  value: {{ .Values.config.runner | quote }}
- name: SANDBOX_PROVIDER
  value: {{ .Values.config.sandboxProvider | quote }}
- name: SANDBOX_WORKSPACE_PATH
  value: {{ .Values.config.sandboxWorkspacePath | quote }}
- name: APP_DATA_STORE
  value: {{ .Values.config.appDataStore | quote }}
- name: FLUE_STATE_STORE
  value: {{ .Values.config.flueStateStore | quote }}
- name: API_AUTH_MODE
  value: {{ .Values.config.apiAuthMode | quote }}
- name: AUTH_PROVIDER
  value: {{ .Values.config.authProvider | quote }}
{{- if .Values.config.authCookieDomain }}
- name: AUTH_COOKIE_DOMAIN
  value: {{ .Values.config.authCookieDomain | quote }}
{{- end }}
- name: AUTH_COOKIE_SECURE
  value: {{ .Values.config.authCookieSecure | quote }}
- name: AUTH_COOKIE_SAME_SITE
  value: {{ .Values.config.authCookieSameSite | quote }}
- name: WEB_BASE_URL
  value: {{ .Values.config.webBaseUrl | quote }}
- name: SERVICE_BASE_DOMAIN
  value: {{ .Values.config.serviceBaseDomain | quote }}
- name: SERVICE_TRUST_FORWARDED_HOSTS
  value: {{ .Values.config.serviceTrustForwardedHosts | quote }}
- name: FLUE_MODEL
  value: {{ .Values.config.flueModel | quote }}
- name: DAYTONA_IMAGE
  value: {{ .Values.config.daytonaImage | quote }}
- name: HIDE_SETUP_PAGE
  value: {{ .Values.config.hideSetupPage | quote }}
{{- if .Values.config.daytonaApiUrl }}
- name: DAYTONA_API_URL
  value: {{ .Values.config.daytonaApiUrl | quote }}
{{- end }}
{{- if .Values.config.daytonaTarget }}
- name: DAYTONA_TARGET
  value: {{ .Values.config.daytonaTarget | quote }}
{{- end }}
{{- if .Values.config.daytonaSnapshot }}
- name: DAYTONA_SNAPSHOT
  value: {{ .Values.config.daytonaSnapshot | quote }}
{{- end }}
- name: ARTIFACT_STORAGE_PROVIDER
  value: {{ .Values.config.artifactStorageProvider | quote }}
- name: ARTIFACT_STORAGE_S3_ENDPOINT
  value: {{ .Values.config.artifactStorageS3Endpoint | quote }}
- name: ARTIFACT_STORAGE_S3_REGION
  value: {{ .Values.config.artifactStorageS3Region | quote }}
- name: ARTIFACT_STORAGE_S3_BUCKET
  value: {{ .Values.config.artifactStorageS3Bucket | quote }}
- name: ARTIFACT_STORAGE_S3_FORCE_PATH_STYLE
  value: {{ .Values.config.artifactStorageS3ForcePathStyle | quote }}
- name: ARTIFACT_STORAGE_S3_CREATE_BUCKET
  value: {{ .Values.config.artifactStorageS3CreateBucket | quote }}
- name: POSTGRES_USER
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" . }}
      key: {{ .Values.postgres.secretKeys.username }}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" . }}
      key: {{ .Values.postgres.secretKeys.password }}
- name: POSTGRES_DATABASE
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" . }}
      key: {{ .Values.postgres.secretKeys.database }}
- name: POSTGRES_HOST
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" . }}
      key: {{ .Values.postgres.secretKeys.host }}
- name: POSTGRES_PORT
  valueFrom:
    secretKeyRef:
      name: {{ include "deputies.postgresSecretName" . }}
      key: {{ .Values.postgres.secretKeys.port }}
- name: DATABASE_URL
  value: postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@$(POSTGRES_HOST):$(POSTGRES_PORT)/$(POSTGRES_DATABASE)
{{- range $name, $value := .Values.config.extraEnv }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}
