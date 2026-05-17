<?php
echo json_encode(
    array(
        'command' => 'wordpress.run-php',
        'plugin_file_exists' => file_exists('/wordpress/wp-content/plugins/simple-plugin/simple-plugin.php'),
        'plugin_readme_exists' => file_exists('/wordpress/wp-content/plugins/simple-plugin/README.md'),
    ),
    JSON_PRETTY_PRINT
);
