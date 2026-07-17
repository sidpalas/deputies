import { useSkillInvocationDraft } from './skill-invocation-draft.js';
import { SkillPicker } from './skill-picker.js';

export type SkillInvocationFieldController = ReturnType<typeof useSkillInvocationDraft>;

export function SkillInvocationField(props: {
  controller: SkillInvocationFieldController;
  availableCount: number;
  enabled: boolean;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
}) {
  const { controller } = props;
  const visible =
    props.enabled && (controller.selectedSkills.length > 0 || controller.pickerOpen || Boolean(props.error));
  if (!visible) return null;

  return (
    <SkillPicker
      availableCount={props.availableCount}
      selected={controller.selectedSkills}
      options={controller.options}
      open={controller.pickerOpen}
      {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      loading={props.loading}
      error={props.error}
      activeIndex={controller.activeIndex}
      activeOptionRef={controller.activeOptionRef}
      onActiveIndexChange={controller.setActiveIndex}
      onRemoveSkill={controller.removeSkill}
      onSelectSkill={controller.selectSkill}
    />
  );
}
