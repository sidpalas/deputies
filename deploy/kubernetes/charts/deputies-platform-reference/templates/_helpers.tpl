{{- define "deputies-platform-reference.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "deputies-platform-reference.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "deputies-platform-reference.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "deputies-platform-reference.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "deputies-platform-reference.selectorLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "deputies-platform-reference.seaweedfsName" -}}
{{- printf "%s-seaweedfs" .Release.Name | trunc 52 | trimSuffix "-" -}}
{{- end -}}

{{- define "deputies-platform-reference.postgresName" -}}
{{- printf "%s-postgres" .Release.Name | trunc 52 | trimSuffix "-" -}}
{{- end -}}
