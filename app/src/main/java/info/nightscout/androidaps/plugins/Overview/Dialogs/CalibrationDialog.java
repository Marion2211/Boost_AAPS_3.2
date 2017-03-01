package info.nightscout.androidaps.plugins.Overview.Dialogs;


import android.content.Context;
import android.os.Bundle;
import android.support.v4.app.DialogFragment;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.text.DecimalFormat;

import info.nightscout.androidaps.Constants;
import info.nightscout.androidaps.MainApp;
import info.nightscout.androidaps.R;
import info.nightscout.androidaps.data.GlucoseStatus;
import info.nightscout.androidaps.plugins.NSClientInternal.data.NSProfile;
import info.nightscout.utils.PlusMinusEditText;
import info.nightscout.utils.XdripCalibrations;

public class CalibrationDialog extends DialogFragment implements View.OnClickListener {
    private static Logger log = LoggerFactory.getLogger(CalibrationDialog.class);

    Button okButton;
    PlusMinusEditText bgText;
    TextView unitsView;

    Context parentContext;

    public CalibrationDialog() {
        // Required empty public constructor
    }

    public void setContext(Context context) {
        parentContext = context;
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {
        View view = inflater.inflate(R.layout.overview_calibration_dialog, container, false);

        getDialog().getWindow().requestFeature(Window.FEATURE_NO_TITLE);
        getDialog().getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN);

        okButton = (Button) view.findViewById(R.id.overview_calibration_okbutton);
        okButton.setOnClickListener(this);

        NSProfile profile = MainApp.getConfigBuilder().getActiveProfile().getProfile();
        Double bg = profile != null ? NSProfile.fromMgdlToUnits(GlucoseStatus.getGlucoseStatusData() != null ? GlucoseStatus.getGlucoseStatusData().glucose : 0d, profile.getUnits()) : 0d;
        if (profile.getUnits().equals(Constants.MMOL))
            bgText = new PlusMinusEditText(view, R.id.overview_calibration_bg, R.id.overview_calibration_bg_plus, R.id.overview_calibration_bg_minus, bg, 0d, 30d, 0.1d, new DecimalFormat("0.0"), false);
        else
            bgText = new PlusMinusEditText(view, R.id.overview_calibration_bg, R.id.overview_calibration_bg_plus, R.id.overview_calibration_bg_minus, bg, 0d, 500d, 1d, new DecimalFormat("0"), false);

        unitsView = (TextView) view.findViewById(R.id.overview_calibration_units);
        unitsView.setText(profile.getUnits());

        return view;
    }

    @Override
    public void onClick(View view) {
        switch (view.getId()) {
            case R.id.overview_calibration_okbutton:
                final Double bg = bgText.getValue();
                XdripCalibrations.confirmAndSendCalibration(bg, parentContext);
                dismiss();
                break;
        }
    }
}
